/**
 * Browser Session
 *
 * Represents a single browser session for NotebookLM interactions.
 *
 * Features:
 * - Human-like question typing
 * - Streaming response detection
 * - Auto-login on session expiry
 * - Session activity tracking
 * - Chat history reset
 *
 * Based on the Python implementation from browser_session.py
 */

import type { BrowserContext, Page } from "patchright";
import fs from "fs/promises";
import path from "path";
import { SharedContextManager } from "./shared-context-manager.js";
import { AuthManager } from "../auth/auth-manager.js";
import { humanType, randomDelay } from "../utils/stealth-utils.js";
import {
  waitForLatestAnswer,
  snapshotAllResponses,
} from "../utils/page-utils.js";
import { CONFIG } from "../config.js";
import { log } from "../utils/logger.js";
import type { SessionInfo, ProgressCallback } from "../types.js";
import { RateLimitError } from "../errors.js";

export class BrowserSession {
  public readonly sessionId: string;
  public readonly notebookUrl: string;
  public readonly createdAt: number;
  public lastActivity: number;
  public messageCount: number;

  private context!: BrowserContext;
  private sharedContextManager: SharedContextManager;
  private authManager: AuthManager;
  private page: Page | null = null;
  private initialized: boolean = false;

  constructor(
    sessionId: string,
    sharedContextManager: SharedContextManager,
    authManager: AuthManager,
    notebookUrl: string
  ) {
    this.sessionId = sessionId;
    this.sharedContextManager = sharedContextManager;
    this.authManager = authManager;
    this.notebookUrl = notebookUrl;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.messageCount = 0;

    log.info(`🆕 BrowserSession ${sessionId} created`);
  }

  /**
   * Initialize the session by creating a page and navigating to the notebook
   */
  async init(): Promise<void> {
    if (this.initialized) {
      log.warning(`⚠️  Session ${this.sessionId} already initialized`);
      return;
    }

    log.info(`🚀 Initializing session ${this.sessionId}...`);

    try {
      // Ensure a valid shared context
      this.context = await this.sharedContextManager.getOrCreateContext();

      // Create new page (tab) in the shared context (with auto-recovery)
      try {
        this.page = await this.context.newPage();
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (/has been closed|Target .* closed|Browser has been closed|Context .* closed/i.test(msg)) {
          log.warning("  ♻️  Context was closed. Recreating and retrying newPage...");
          this.context = await this.sharedContextManager.getOrCreateContext();
          this.page = await this.context.newPage();
        } else {
          throw e;
        }
      }
      log.success(`  ✅ Created new page`);

      // Navigate to notebook
      log.info(`  🌐 Navigating to: ${this.notebookUrl}`);
      await this.page.goto(this.notebookUrl, {
        waitUntil: "domcontentloaded",
        timeout: CONFIG.browserTimeout,
      });

      // Wait for page to stabilize
      await randomDelay(2000, 3000);

      // Check if we need to login
      const isAuthenticated = await this.authManager.validateCookiesExpiry(
        this.context
      );

      if (!isAuthenticated) {
        log.warning(`  🔑 Session ${this.sessionId} needs authentication`);
        const loginSuccess = await this.ensureAuthenticated();
        if (!loginSuccess) {
          throw new Error("Failed to authenticate session");
        }
      } else {
        log.success(`  ✅ Session already authenticated`);
      }

      // CRITICAL: Restore sessionStorage from saved state
      // This is essential for maintaining Google session state!
      log.info(`  🔄 Restoring sessionStorage...`);
      const sessionData = await this.authManager.loadSessionStorage();
      if (sessionData) {
        const entryCount = Object.keys(sessionData).length;
        if (entryCount > 0) {
          await this.restoreSessionStorage(sessionData, entryCount);
        } else {
          log.info(`  ℹ️  SessionStorage empty (fresh session)`);
        }
      } else {
        log.info(`  ℹ️  No saved sessionStorage found (fresh session)`);
      }

      // Wait for NotebookLM interface to load
      log.info(`  ⏳ Waiting for NotebookLM interface...`);
      await this.waitForNotebookLMReady();

      this.initialized = true;
      this.updateActivity();
      log.success(`✅ Session ${this.sessionId} initialized successfully`);
    } catch (error) {
      log.error(`❌ Failed to initialize session ${this.sessionId}: ${error}`);
      if (this.page) {
        await this.page.close();
        this.page = null;
      }
      throw error;
    }
  }

  /**
   * Wait for NotebookLM interface to be ready
   *
   * IMPORTANT: Matches Python implementation EXACTLY!
   * - Uses SPECIFIC selectors (textarea.query-box-input)
   * - Checks ONLY for "visible" state (NOT disabled!)
   * - NO placeholder checks (let NotebookLM handle that!)
   *
   * Based on Python _wait_for_ready() from browser_session.py:104-113
   */
  private async waitForNotebookLMReady(): Promise<void> {
    if (!this.page) {
      throw new Error("Page not initialized");
    }

    try {
      // PRIMARY: Exact Python selector - textarea.query-box-input
      log.info("  ⏳ Waiting for chat input (textarea.query-box-input)...");
      await this.page.waitForSelector("textarea.query-box-input", {
        timeout: 10000, // Python uses 10s timeout
        state: "visible", // ONLY check visibility (NO disabled check!)
      });
      log.success("  ✅ Chat input ready!");
    } catch {
      // FALLBACK: Python alternative selector
      try {
        log.info("  ⏳ Trying fallback selector (aria-label)...");
        await this.page.waitForSelector('textarea[aria-label="Feld für Anfragen"]', {
          timeout: 5000, // Python uses 5s for fallback
          state: "visible",
        });
        log.success("  ✅ Chat input ready (fallback)!");
      } catch (error) {
        log.error(`  ❌ NotebookLM interface not ready: ${error}`);
        throw new Error(
          "Could not find NotebookLM chat input. " +
          "Please ensure the notebook page has loaded correctly."
        );
      }
    }
  }

  private isPageClosedSafe(): boolean {
    if (!this.page) return true;
    const p: any = this.page as any;
    try {
      if (typeof p.isClosed === 'function') {
        if (p.isClosed()) return true;
      }
      // Accessing URL should be safe; if page is gone, this may throw
      void this.page.url();
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Ensure the session is authenticated, perform auto-login if needed
   */
  private async ensureAuthenticated(): Promise<boolean> {
    if (!this.page) {
      throw new Error("Page not initialized");
    }

    log.info(`🔑 Checking authentication for session ${this.sessionId}...`);

    // Check cookie validity
    const isValid = await this.authManager.validateCookiesExpiry(this.context);

    if (isValid) {
      log.success(`  ✅ Cookies valid`);
      return true;
    }

    log.warning(`  ⚠️  Cookies expired or invalid`);

    // Try to get valid auth state
    const statePath = await this.authManager.getValidStatePath();

    if (statePath) {
      // Load saved state
      log.info(`  📂 Loading auth state from: ${statePath}`);
      await this.authManager.loadAuthState(this.context, statePath);

      // Reload page to apply new auth
      log.info(`  🔄 Reloading page...`);
      await (this.page as Page).reload({ waitUntil: "domcontentloaded" });
      await randomDelay(2000, 3000);

      // Check if it worked
      const nowValid = await this.authManager.validateCookiesExpiry(
        this.context
      );
      if (nowValid) {
        log.success(`  ✅ Auth state loaded successfully`);
        return true;
      }
    }

    // Need fresh login
    log.warning(`  🔑 Fresh login required`);

    if (CONFIG.autoLoginEnabled) {
      log.info(`  🤖 Attempting auto-login...`);
      const loginSuccess = await this.authManager.loginWithCredentials(
        this.context,
        this.page,
        CONFIG.loginEmail,
        CONFIG.loginPassword
      );

      if (loginSuccess) {
        log.success(`  ✅ Auto-login successful`);
        // Navigate back to notebook
        await this.page.goto(this.notebookUrl, {
          waitUntil: "domcontentloaded",
        });
        await randomDelay(2000, 3000);
        return true;
      } else {
        log.error(`  ❌ Auto-login failed`);
        return false;
      }
    } else {
      log.error(
        `  ❌ Auto-login disabled and no valid auth state - manual login required`
      );
      return false;
    }
  }

  private getOriginFromUrl(url: string): string | null {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }

  /**
   * Safely restore sessionStorage when the page is on the expected origin
   */
  private async restoreSessionStorage(
    sessionData: Record<string, string>,
    entryCount: number
  ): Promise<void> {
    if (!this.page) {
      log.warning(`  ⚠️  Cannot restore sessionStorage without an active page`);
      return;
    }

    const targetOrigin = this.getOriginFromUrl(this.notebookUrl);
    if (!targetOrigin) {
      log.warning(`  ⚠️  Unable to determine target origin for sessionStorage restore`);
      return;
    }

    let restored = false;

    const applyToPage = async (): Promise<boolean> => {
      if (!this.page) {
        return false;
      }

      const currentOrigin = this.getOriginFromUrl(this.page.url());
      if (currentOrigin !== targetOrigin) {
        return false;
      }

      try {
        await this.page.evaluate((data) => {
          for (const [key, value] of Object.entries(data)) {
            // @ts-expect-error - sessionStorage exists in browser context
            sessionStorage.setItem(key, value);
          }
        }, sessionData);
        restored = true;
        log.success(`  ✅ SessionStorage restored: ${entryCount} entries`);
        return true;
      } catch (error) {
        log.warning(`  ⚠️  Failed to restore sessionStorage: ${error}`);
        return false;
      }
    };

    if (await applyToPage()) {
      return;
    }

    log.info(`  ⏳ Waiting for NotebookLM origin before restoring sessionStorage...`);

    const handleNavigation = async () => {
      if (restored) {
        return;
      }

      if (await applyToPage()) {
        this.page?.off("framenavigated", handleNavigation);
      }
    };

    this.page.on("framenavigated", handleNavigation);
  }

  /**
   * Ask a question to NotebookLM
   */
  async ask(question: string, sendProgress?: ProgressCallback): Promise<string> {
    const askOnce = async (): Promise<string> => {
      if (!this.initialized || !this.page || this.isPageClosedSafe()) {
        log.warning(`  ℹ️  Session not initialized or page missing → re-initializing...`);
        await this.init();
      }

      log.info(`💬 [${this.sessionId}] Asking: "${question.substring(0, 100)}..."`);
      const page = this.page!;
      // Ensure we're still authenticated
      await sendProgress?.("Verifying authentication...", 2, 5);
      const isAuth = await this.authManager.validateCookiesExpiry(this.context);
      if (!isAuth) {
        log.warning(`  🔑 Session expired, re-authenticating...`);
        await sendProgress?.("Re-authenticating session...", 2, 5);
        const reAuthSuccess = await this.ensureAuthenticated();
        if (!reAuthSuccess) {
          throw new Error("Failed to re-authenticate session");
        }
      }

      // Snapshot existing responses BEFORE asking
      log.info(`  📸 Snapshotting existing responses...`);
      const existingResponses = await snapshotAllResponses(page);
      log.success(`  ✅ Captured ${existingResponses.length} existing responses`);

      // Find the chat input
      const inputSelector = await this.findChatInput();
      if (!inputSelector) {
        throw new Error(
          "Could not find visible chat input element. " +
          "Please check if the notebook page has loaded correctly."
        );
      }

      log.info(`  ⌨️  Typing question with human-like behavior...`);
      await sendProgress?.("Typing question with human-like behavior...", 2, 5);
      await humanType(page, inputSelector, question, {
        withTypos: true,
        wpm: Math.max(CONFIG.typingWpmMin, CONFIG.typingWpmMax),
      });

      // Small pause before submitting
      await randomDelay(500, 1000);

      // Submit the question (Enter key)
      log.info(`  📤 Submitting question...`);
      await sendProgress?.("Submitting question...", 3, 5);
      await page.keyboard.press("Enter");

      // Small pause after submit
      await randomDelay(1000, 1500);

      // Wait for the response with streaming detection
      log.info(`  ⏳ Waiting for response (with streaming detection)...`);
      await sendProgress?.("Waiting for NotebookLM response (streaming detection active)...", 3, 5);
      const answer = await waitForLatestAnswer(page, {
        question,
        timeoutMs: 120000, // 2 minutes
        pollIntervalMs: 1000,
        ignoreTexts: existingResponses,
        debug: false,
      });

      if (!answer) {
        throw new Error("Timeout waiting for response from NotebookLM");
      }

      // Check for rate limit errors AFTER receiving answer
      log.info(`  🔍 Checking for rate limit errors...`);
      if (await this.detectRateLimitError()) {
        throw new RateLimitError(
          "NotebookLM rate limit reached (50 queries/day for free accounts)"
        );
      }

      // Update session stats
      this.messageCount++;
      this.updateActivity();

      log.success(
        `✅ [${this.sessionId}] Received answer (${answer.length} chars, ${this.messageCount} total messages)`
      );

      return answer;
    };

    try {
      return await askOnce();
    } catch (error: any) {
      const msg = String(error?.message || error);
      if (/has been closed|Target .* closed|Browser has been closed|Context .* closed/i.test(msg)) {
        log.warning(`  ♻️  Detected closed page/context. Recovering session and retrying ask...`);
        try {
          this.initialized = false;
          if (this.page) { try { await this.page.close(); } catch {} }
          this.page = null;
          await this.init();
          return await askOnce();
        } catch (e2) {
          log.error(`❌ Recovery failed: ${e2}`);
          throw e2;
        }
      }
      log.error(`❌ [${this.sessionId}] Failed to ask question: ${msg}`);
      throw error;
    }
  }

  /**
   * Find the chat input element
   *
   * IMPORTANT: Matches Python implementation EXACTLY!
   * - Uses SPECIFIC selectors from Python
   * - Checks ONLY visibility (NOT disabled state!)
   *
   * Based on Python ask() method from browser_session.py:166-171
   */
  private async findChatInput(): Promise<string | null> {
    if (!this.page) {
      return null;
    }

    // Use EXACT Python selectors (in order of preference)
    const selectors = [
      "textarea.query-box-input", // ← PRIMARY Python selector
      'textarea[aria-label="Feld für Anfragen"]', // ← Python fallback
    ];

    for (const selector of selectors) {
      try {
        const element = await this.page.$(selector);
        if (element) {
          const isVisible = await element.isVisible();
          if (isVisible) {
            // NO disabled check! Just like Python!
            log.success(`  ✅ Found chat input: ${selector}`);
            return selector;
          }
        }
      } catch {
        continue;
      }
    }

    log.error(`  ❌ Could not find visible chat input`);
    return null;
  }

  /**
   * Detect if a rate limit error occurred
   *
   * Searches the page for error messages indicating rate limit/quota exhaustion.
   * Free NotebookLM accounts have 50 queries/day limit.
   *
   * @returns true if rate limit error detected, false otherwise
   */
  private async detectRateLimitError(): Promise<boolean> {
    if (!this.page) {
      return false;
    }

    // Error message selectors (common patterns for error containers)
    const errorSelectors = [
      ".error-message",
      ".error-container",
      "[role='alert']",
      ".rate-limit-message",
      "[data-error]",
      ".notification-error",
      ".alert-error",
      ".toast-error",
    ];

    // Keywords that indicate rate limiting
    const keywords = [
      "rate limit",
      "limit exceeded",
      "quota exhausted",
      "daily limit",
      "limit reached",
      "too many requests",
      "ratenlimit",
      "quota",
      "query limit",
      "request limit",
    ];

    // Check error containers for rate limit messages
    for (const selector of errorSelectors) {
      try {
        const elements = await this.page.$$(selector);
        for (const el of elements) {
          try {
            const text = await el.innerText();
            const lower = text.toLowerCase();

            if (keywords.some((k) => lower.includes(k))) {
              log.error(`🚫 Rate limit detected: ${text.slice(0, 100)}`);
              return true;
            }
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    // Also check if chat input is disabled (sometimes NotebookLM disables input when rate limited)
    try {
      const inputSelector = "textarea.query-box-input";
      const input = await this.page.$(inputSelector);
      if (input) {
        const isDisabled = await input.evaluate((el: any) => {
          return el.disabled || el.hasAttribute("disabled");
        });

        if (isDisabled) {
          // Check if there's an error message near the input
          const parent = await input.evaluateHandle((el) => el.parentElement);
          const parentEl = parent.asElement();
          if (parentEl) {
            try {
              const parentText = await parentEl.innerText();
              const lower = parentText.toLowerCase();
              if (keywords.some((k) => lower.includes(k))) {
                log.error(`🚫 Rate limit detected: Chat input disabled with error message`);
                return true;
              }
            } catch {
              // Ignore
            }
          }
        }
      }
    } catch {
      // Ignore errors checking input state
    }

    return false;
  }

  /**
   * Reset the chat history (start a new conversation)
   */
  async reset(): Promise<void> {
    const resetOnce = async (): Promise<void> => {
      if (!this.initialized || !this.page || this.isPageClosedSafe()) {
        await this.init();
      }
      log.info(`🔄 [${this.sessionId}] Resetting chat history...`);
      // Reload the page to clear chat history
      await (this.page as Page).reload({ waitUntil: "domcontentloaded" });
      await randomDelay(2000, 3000);

      // Wait for interface to be ready again
      await this.waitForNotebookLMReady();

      // Reset message count
      this.messageCount = 0;
      this.updateActivity();

      log.success(`✅ [${this.sessionId}] Chat history reset`);
    };

    try {
      await resetOnce();
    } catch (error: any) {
      const msg = String(error?.message || error);
      if (/has been closed|Target .* closed|Browser has been closed|Context .* closed/i.test(msg)) {
        log.warning(`  ♻️  Detected closed page/context during reset. Recovering and retrying...`);
        this.initialized = false;
        if (this.page) { try { await this.page.close(); } catch {} }
        this.page = null;
        await this.init();
        await resetOnce();
        return;
      }
      log.error(`❌ [${this.sessionId}] Failed to reset: ${msg}`);
      throw error;
    }
  }

  /**
   * Upload a local source file to the current NotebookLM notebook.
   */
  async uploadSource(
    filePath: string,
    sourceTitle: string,
    sendProgress?: ProgressCallback
  ): Promise<{ status: string; notebook_url: string; source_title: string; uploaded_at: string; message?: string }> {
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        throw new Error(`Source path is not a file: ${filePath}`);
      }
    } catch (error) {
      throw new Error(`Source file is not accessible: ${filePath}. ${error}`);
    }

    if (!this.initialized || !this.page || this.isPageClosedSafe()) {
      await this.init();
    }

    const page = this.page!;
    log.info(`📎 [${this.sessionId}] Uploading source: ${filePath}`);

    const isAuth = await this.authManager.validateCookiesExpiry(this.context);
    if (!isAuth) {
      await sendProgress?.("Re-authenticating session...", 1, 6);
      const reAuthSuccess = await this.ensureAuthenticated();
      if (!reAuthSuccess) throw new Error("Failed to re-authenticate session");
    }

    await sendProgress?.("Opening source upload control...", 2, 6);

    const fileName = path.basename(filePath);
    const sourceStem = path.basename(filePath, path.extname(filePath));
    const addSourceSelectors = [
      'button[aria-label="Add source"]',
      'button[aria-label="Adicionar fonte"]',
      'button[aria-label="Add sources"]',
      'button[aria-label="Adicionar fontes"]',
      '[data-testid="add-source-button"]',
      'button:has-text("Add source")',
      'button:has-text("Add sources")',
      'button:has-text("Adicionar fonte")',
      'button:has-text("Adicionar fontes")',
      'button:has-text("Upload source")',
      'button:has-text("Upload")',
    ];

    const setInputFilesIfPresent = async (): Promise<boolean> => {
      const inputs = await page.$$('input[type="file"]');
      for (const input of inputs) {
        try {
          await input.setInputFiles(filePath);
          log.success(`  ✅ Set file via existing input[type=file]`);
          return true;
        } catch {
          continue;
        }
      }
      return false;
    };

    let submitted = await setInputFilesIfPresent();

    if (!submitted) {
      for (const selector of addSourceSelectors) {
        try {
          const button = await page.$(selector);
          if (!button || !(await button.isVisible())) {
            continue;
          }

          const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
          await button.click();
          await randomDelay(500, 900);
          const chooser = await fileChooserPromise;

          if (chooser) {
            await chooser.setFiles(filePath);
            submitted = true;
            log.success(`  ✅ Uploaded via file chooser opened by: ${selector}`);
            break;
          }

          if (await setInputFilesIfPresent()) {
            submitted = true;
            log.success(`  ✅ Uploaded via file input after clicking: ${selector}`);
            break;
          }
        } catch {
          continue;
        }
      }
    }

    if (!submitted) {
      throw new Error(
        "Could not find NotebookLM source upload control. " +
        "Open the notebook once manually or retry with show_browser=true to inspect the UI."
      );
    }

    await sendProgress?.("Waiting for NotebookLM to process the uploaded source...", 4, 6);

    const timeoutMs = 90_000;
    const pollMs = 2_500;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      await randomDelay(pollMs - 300, pollMs + 300);

      const bodyText = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        return doc?.body?.innerText || "";
      });
      const normalized = bodyText.toLowerCase();
      const titleNeedles = [sourceTitle, fileName, sourceStem]
        .filter(Boolean)
        .map((value) => value.toLowerCase());

      if (titleNeedles.some((needle) => normalized.includes(needle))) {
        await sendProgress?.("Source uploaded successfully!", 6, 6);
        this.updateActivity();
        return {
          status: "success",
          notebook_url: this.notebookUrl,
          source_title: sourceTitle,
          uploaded_at: new Date().toISOString(),
        };
      }

      const errorKeywords = [
        "upload failed",
        "couldn't upload",
        "could not upload",
        "falha no upload",
        "nao foi possivel fazer upload",
        "não foi possível fazer upload",
      ];
      if (errorKeywords.some((keyword) => normalized.includes(keyword))) {
        throw new Error("NotebookLM reported a source upload failure");
      }
    }

    this.updateActivity();
    return {
      status: "submitted",
      notebook_url: this.notebookUrl,
      source_title: sourceTitle,
      uploaded_at: new Date().toISOString(),
      message:
        "File was submitted, but the source title was not detected before timeout. " +
        "Check the notebook source list directly.",
    };
  }

  async addSource(
    args: {
      source_type: "url" | "youtube" | "text" | "file";
      url?: string;
      text?: string;
      file_path?: string;
      title?: string;
      wait?: boolean;
    },
    sendProgress?: ProgressCallback
  ): Promise<{
    status: string;
    source_type: string;
    notebook_url: string;
    source_title?: string;
    added_at: string;
    message?: string;
  }> {
    const { source_type, url, text, file_path, title, wait = true } = args;

    if (source_type === "file") {
      if (!file_path) {
        throw new Error("file_path is required for file sources");
      }
      const uploaded = await this.uploadSource(
        file_path,
        title || path.basename(file_path),
        sendProgress
      );
      return {
        status: uploaded.status,
        source_type,
        notebook_url: uploaded.notebook_url,
        source_title: uploaded.source_title,
        added_at: uploaded.uploaded_at,
        message: uploaded.message,
      };
    }

    if ((source_type === "url" || source_type === "youtube") && !url) {
      throw new Error(`url is required for ${source_type} sources`);
    }
    if (source_type === "text" && !text) {
      throw new Error("text is required for text sources");
    }

    if (!this.initialized || !this.page || this.isPageClosedSafe()) {
      await this.init();
    }

    const page = this.page!;
    log.info(`📎 [${this.sessionId}] Adding ${source_type} source`);

    const isAuth = await this.authManager.validateCookiesExpiry(this.context);
    if (!isAuth) {
      await sendProgress?.("Re-authenticating session...", 1, 6);
      const reAuthSuccess = await this.ensureAuthenticated();
      if (!reAuthSuccess) throw new Error("Failed to re-authenticate session");
    }

    await sendProgress?.("Opening source add control...", 2, 6);
    await this.openAddSourceDialog(page);

    if (source_type === "url" || source_type === "youtube") {
      await sendProgress?.("Adding URL source...", 3, 6);
      await this.chooseSourceDialogOption(page, [
        "Website",
        "Web",
        "URL",
        "Site",
        "Link",
        "YouTube",
        "Youtube",
      ]);
      await this.fillFirstVisibleInput(page, url!);
    } else {
      await sendProgress?.("Adding text source...", 3, 6);
      await this.chooseSourceDialogOption(page, [
        "Copied text",
        "Paste text",
        "Text",
        "Texto copiado",
        "Colar texto",
        "Texto",
      ]);
      await this.fillFirstVisibleTextArea(page, text!, title);
    }

    await sendProgress?.("Submitting source...", 4, 6);
    await this.clickSourceSubmit(page);

    const sourceTitle = title || url || "Pasted text";
    if (wait) {
      await sendProgress?.("Waiting for source to appear in NotebookLM...", 5, 6);
      const detected = await this.waitForSourceText(page, sourceTitle, 90_000);
      this.updateActivity();

      if (detected) {
        await sendProgress?.("Source added successfully!", 6, 6);
        return {
          status: "success",
          source_type,
          notebook_url: this.notebookUrl,
          source_title: sourceTitle,
          added_at: new Date().toISOString(),
        };
      }

      return {
        status: "submitted",
        source_type,
        notebook_url: this.notebookUrl,
        source_title: sourceTitle,
        added_at: new Date().toISOString(),
        message:
          "Source was submitted, but it was not detected in the visible source list before timeout. " +
          "Use source_list or check the notebook directly.",
      };
    }

    this.updateActivity();
    return {
      status: "submitted",
      source_type,
      notebook_url: this.notebookUrl,
      source_title: sourceTitle,
      added_at: new Date().toISOString(),
    };
  }

  async listSources(
    sendProgress?: ProgressCallback
  ): Promise<{
    status: string;
    notebook_url: string;
    count: number;
    sources: Array<{ title: string; status?: string; raw_text?: string }>;
    message?: string;
  }> {
    if (!this.initialized || !this.page || this.isPageClosedSafe()) {
      await this.init();
    }

    const page = this.page!;
    await sendProgress?.("Reading NotebookLM source list...", 2, 4);

    const sources = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const candidates = Array.from(
        doc.querySelectorAll(
          [
            '[data-testid*="source"]',
            '[class*="source"]',
            '[aria-label*="source" i]',
            '[aria-label*="fonte" i]',
            "mat-list-item",
            "li",
          ].join(",")
        )
      ) as any[];

      const seen = new Set<string>();
      const rows: Array<{ title: string; status?: string; raw_text?: string }> = [];
      const noisy = /^(add source|add sources|adicionar fonte|adicionar fontes|sources|fontes)$/i;

      for (const el of candidates) {
        const raw = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (!raw || raw.length < 3 || raw.length > 500 || noisy.test(raw)) {
          continue;
        }

        const lower = raw.toLowerCase();
        const status =
          lower.includes("processing") || lower.includes("processando")
            ? "processing"
            : lower.includes("failed") || lower.includes("falha")
              ? "failed"
              : undefined;

        const title = raw
          .split(/\b(processing|processando|failed|falha|erro)\b/i)[0]
          .trim()
          .slice(0, 180);

        if (!title || seen.has(title.toLowerCase())) {
          continue;
        }

        seen.add(title.toLowerCase());
        rows.push({ title, status, raw_text: raw });
      }

      return rows.slice(0, 100);
    });

    this.updateActivity();
    await sendProgress?.("Source list read successfully.", 4, 4);

    return {
      status: "success",
      notebook_url: this.notebookUrl,
      count: sources.length,
      sources,
      ...(sources.length === 0 && {
        message:
          "No visible sources were detected. The notebook may be empty, still loading, or Google changed the source list markup.",
      }),
    };
  }

  private async openAddSourceDialog(page: Page): Promise<void> {
    const selectors = [
      'button[aria-label="Add source"]',
      'button[aria-label="Adicionar fonte"]',
      'button[aria-label="Add sources"]',
      'button[aria-label="Adicionar fontes"]',
      '[data-testid="add-source-button"]',
      'button:has-text("Add source")',
      'button:has-text("Add sources")',
      'button:has-text("Adicionar fonte")',
      'button:has-text("Adicionar fontes")',
    ];

    for (const selector of selectors) {
      try {
        const button = await page.$(selector);
        if (button && (await button.isVisible())) {
          await button.click();
          await randomDelay(700, 1200);
          log.success(`  ✅ Opened source dialog via: ${selector}`);
          return;
        }
      } catch {
        continue;
      }
    }

    throw new Error(
      "Could not find NotebookLM add source control. Retry with show_browser=true to inspect the UI."
    );
  }

  private async chooseSourceDialogOption(page: Page, labels: string[]): Promise<void> {
    for (const label of labels) {
      const selectors = [
        `button:has-text("${label}")`,
        `[role="button"]:has-text("${label}")`,
        `div:has-text("${label}")`,
      ];

      for (const selector of selectors) {
        try {
          const el = await page.$(selector);
          if (el && (await el.isVisible())) {
            await el.click();
            await randomDelay(500, 900);
            log.success(`  ✅ Chose source dialog option: ${label}`);
            return;
          }
        } catch {
          continue;
        }
      }
    }

    log.warning("  ⚠️  Could not choose a source dialog option; trying visible input directly");
  }

  private async fillFirstVisibleInput(page: Page, value: string): Promise<void> {
    const selectors = [
      'input[type="url"]',
      'input[placeholder*="URL" i]',
      'input[aria-label*="URL" i]',
      'input[placeholder*="link" i]',
      'input[aria-label*="link" i]',
      'input',
    ];

    for (const selector of selectors) {
      const inputs = await page.$$(selector);
      for (const input of inputs) {
        try {
          if (!(await input.isVisible())) {
            continue;
          }
          await input.fill(value);
          await randomDelay(250, 500);
          return;
        } catch {
          continue;
        }
      }
    }

    throw new Error("Could not find a visible URL input in the NotebookLM source dialog");
  }

  private async fillFirstVisibleTextArea(
    page: Page,
    value: string,
    title?: string
  ): Promise<void> {
    if (title) {
      const titleInputs = await page.$$('input:not([type="file"])');
      for (const input of titleInputs) {
        try {
          if (await input.isVisible()) {
            await input.fill(title);
            await randomDelay(200, 400);
            break;
          }
        } catch {
          continue;
        }
      }
    }

    const textareas = await page.$$("textarea");
    for (const textarea of textareas) {
      try {
        if (!(await textarea.isVisible())) {
          continue;
        }
        const className = await textarea.getAttribute("class");
        if (className?.includes("query-box-input")) {
          continue;
        }
        await textarea.fill(value);
        await randomDelay(250, 500);
        return;
      } catch {
        continue;
      }
    }

    const editable = await page.$$('[contenteditable="true"]');
    for (const el of editable) {
      try {
        if (!(await el.isVisible())) {
          continue;
        }
        await el.fill(value);
        await randomDelay(250, 500);
        return;
      } catch {
        continue;
      }
    }

    throw new Error("Could not find a visible text input in the NotebookLM source dialog");
  }

  private async clickSourceSubmit(page: Page): Promise<void> {
    const selectors = [
      'button:has-text("Insert")',
      'button:has-text("Add")',
      'button:has-text("Submit")',
      'button:has-text("Adicionar")',
      'button:has-text("Inserir")',
      'button:has-text("Enviar")',
      'button[type="submit"]',
    ];

    for (const selector of selectors) {
      try {
        const button = await page.$(selector);
        if (button && (await button.isVisible())) {
          await button.click();
          await randomDelay(800, 1200);
          return;
        }
      } catch {
        continue;
      }
    }

    await page.keyboard.press("Enter");
    await randomDelay(800, 1200);
  }

  private async waitForSourceText(
    page: Page,
    sourceText: string,
    timeoutMs: number
  ): Promise<boolean> {
    const start = Date.now();
    const needles = [sourceText];
    try {
      const url = new URL(sourceText);
      needles.push(url.hostname, url.pathname.split("/").filter(Boolean).pop() || "");
    } catch {
      // sourceText may be a plain title.
    }

    while (Date.now() - start < timeoutMs) {
      await randomDelay(2200, 2800);
      const bodyText = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        return doc?.body?.innerText || "";
      });
      const normalized = bodyText.toLowerCase();

      if (
        needles
          .filter(Boolean)
          .some((needle) => normalized.includes(needle.toLowerCase()))
      ) {
        return true;
      }

      const errors = [
        "couldn't add",
        "could not add",
        "failed to add",
        "falha ao adicionar",
        "nao foi possivel adicionar",
        "não foi possível adicionar",
      ];
      if (errors.some((error) => normalized.includes(error))) {
        throw new Error("NotebookLM reported a source add failure");
      }
    }

    return false;
  }

  /**
   * Generate content using NotebookLM's built-in generation features.
   * Clicks the appropriate button in the notebook overview panel and extracts the result.
   *
   * NotebookLM's "Notebook guide" panel contains buttons for:
   * - Audio Overview (podcast generation)
   * - Study Guide
   * - Briefing Doc
   * - FAQ
   * - Timeline
   *
   * The panel is opened via the notebook guide button on the right side of the UI.
   */
  async generateContent(
    type: "audio_overview" | "study_guide" | "briefing_doc" | "faq" | "timeline" | "presentation",
    sendProgress?: ProgressCallback,
    _options?: { focus?: string; style?: string }
  ): Promise<{ status: string; content?: string; audio_url?: string; message?: string }> {
    if (!this.initialized || !this.page || this.isPageClosedSafe()) {
      await this.init();
    }

    const page = this.page!;
    log.info(`📄 [${this.sessionId}] Generating ${type}...`);

    // Ensure we're still authenticated
    const isAuth = await this.authManager.validateCookiesExpiry(this.context);
    if (!isAuth) {
      await sendProgress?.("Re-authenticating session...", 1, 6);
      const reAuthSuccess = await this.ensureAuthenticated();
      if (!reAuthSuccess) throw new Error("Failed to re-authenticate session");
    }

    await sendProgress?.("Opening Notebook Guide panel...", 1, 6);

    // Open the Notebook Guide panel if not already open
    // The button varies by NotebookLM version — try multiple selectors
    const guideButtonSelectors = [
      'button[aria-label="Notebook guide"]',
      'button[aria-label="Notizbuchübersicht"]', // German locale fallback
      '[data-testid="notebook-guide-button"]',
      'button.notebook-guide-button',
      // Fallback: button containing "Notebook guide" text
      'button:has-text("Notebook guide")',
    ];

    let panelOpened = false;
    for (const sel of guideButtonSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn && (await btn.isVisible())) {
          await btn.click();
          await randomDelay(800, 1200);
          panelOpened = true;
          log.success(`  ✅ Opened Notebook Guide panel via: ${sel}`);
          break;
        }
      } catch { continue; }
    }

    if (!panelOpened) {
      // The panel may already be open — continue anyway
      log.warning("  ⚠️  Could not find Notebook Guide button, panel may already be open");
    }

    await sendProgress?.("Locating generation button...", 2, 6);

    // Map type to button label/selector patterns
    const buttonMap: Record<string, string[]> = {
      audio_overview: [
        'button[aria-label="Generate audio overview"]',
        'button:has-text("Generate")',
        '[data-testid="audio-overview-generate"]',
        'button.audio-overview-button',
      ],
      study_guide: [
        'button[aria-label="Study guide"]',
        'button:has-text("Study guide")',
        '[data-testid="study-guide-button"]',
        'button.study-guide-button',
      ],
      briefing_doc: [
        'button[aria-label="Briefing doc"]',
        'button:has-text("Briefing doc")',
        '[data-testid="briefing-doc-button"]',
        'button.briefing-doc-button',
      ],
      faq: [
        'button[aria-label="FAQ"]',
        'button:has-text("FAQ")',
        '[data-testid="faq-button"]',
        'button.faq-button',
      ],
      timeline: [
        'button[aria-label="Timeline"]',
        'button:has-text("Timeline")',
        '[data-testid="timeline-button"]',
        'button.timeline-button',
      ],
      // Presentation: confirmed selector from live DOM inspection (PT-BR UI)
      // The button contains a span.create-label-container with text "Apresentação de slides"
      presentation: [
        'button:has(span.create-label-container)',
        'button:has-text("Apresentação de slides")',
        'button:has-text("Slide presentation")',
        'button:has-text("Create slides")',
        '[data-testid="presentation-button"]',
      ],
    };

    const selectors = buttonMap[type] ?? [];
    let clicked = false;

    for (const sel of selectors) {
      try {
        const btn = await page.$(sel);
        if (btn && (await btn.isVisible())) {
          await btn.click();
          await randomDelay(500, 900);
          clicked = true;
          log.success(`  ✅ Clicked ${type} button via: ${sel}`);
          break;
        }
      } catch { continue; }
    }

    if (!clicked) {
      throw new Error(
        `Could not find the "${type}" button in the Notebook Guide panel. ` +
        "Make sure the notebook is loaded and the guide panel is accessible."
      );
    }

    if (type === "presentation") {
      return this.generatePresentation(page, sendProgress);
    }

    if (type === "audio_overview") {
      return this.waitForAudioOverview(page, sendProgress);
    }

    return this.waitForGeneratedText(page, type, sendProgress);
  }

  /**
   * Handle presentation generation.
   * NotebookLM opens the "Estúdio" tab and creates a Google Slides presentation.
   * The button is identified by span.create-label-container with text "Apresentação de slides".
   * After clicking, NotebookLM redirects to or opens Google Slides in a new tab.
   */
  private async generatePresentation(
    page: Page,
    sendProgress?: ProgressCallback
  ): Promise<{ status: string; presentation_url?: string; message?: string }> {
    await sendProgress?.("Navigating to Estúdio tab...", 2, 6);

    // First: click the "Estúdio" tab (confirmed selector from live DOM)
    // The tab has text "Estúdio" inside span.mdc-tab__text-label
    const studioTabSelectors = [
      'div[role="tab"]:has-text("Estúdio")',
      'div[role="tab"]:has-text("Studio")',
      '.mdc-tab:has-text("Estúdio")',
      '.mdc-tab:has-text("Studio")',
    ];

    let tabClicked = false;
    for (const sel of studioTabSelectors) {
      try {
        const tab = await page.$(sel);
        if (tab && (await tab.isVisible())) {
          await tab.click();
          await randomDelay(800, 1200);
          tabClicked = true;
          log.success(`  ✅ Clicked Estúdio tab via: ${sel}`);
          break;
        }
      } catch { continue; }
    }

    if (!tabClicked) {
      log.warning("  ⚠️  Could not find Estúdio tab — may already be active");
    }

    await sendProgress?.("Clicking Apresentação de slides button...", 3, 6);

    // Click the presentation button — confirmed: span.create-label-container with "Apresentação de slides"
    const presentationButtonSelectors = [
      'button:has(span.create-label-container)',
      'button:has-text("Apresentação de slides")',
      'button:has-text("Slide presentation")',
      'button:has-text("Create slides")',
    ];

    let btnClicked = false;
    for (const sel of presentationButtonSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn && (await btn.isVisible())) {
          await btn.click();
          await randomDelay(1000, 1500);
          btnClicked = true;
          log.success(`  ✅ Clicked presentation button via: ${sel}`);
          break;
        }
      } catch { continue; }
    }

    if (!btnClicked) {
      throw new Error(
        'Could not find the "Apresentação de slides" button. ' +
        "Make sure the Estúdio tab is available in your NotebookLM account."
      );
    }

    await sendProgress?.("Waiting for presentation to generate...", 4, 6);

    // Poll for new tab opening (Google Slides) or a presentation link appearing
    const timeoutMs = 4 * 60 * 1000; // 4 minutes
    const pollMs = 5_000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      await randomDelay(pollMs - 500, pollMs + 500);
      const elapsed = Math.round((Date.now() - start) / 1000);
      await sendProgress?.(
        `Generating presentation... ${elapsed}s elapsed (typically 1–3 min)`,
        4,
        6
      );

      // Check if a new page/tab opened with Google Slides
      try {
        const pages = page.context().pages();
        for (const p of pages) {
          const url = p.url();
          if (url.includes("docs.google.com/presentation") || url.includes("slides.google.com")) {
            log.success(`  ✅ Presentation ready: ${url}`);
            await sendProgress?.("Presentation generated successfully!", 6, 6);
            return {
              status: "success",
              presentation_url: url,
              message: `Presentation is ready: ${url}`,
            };
          }
        }
      } catch { /* continue polling */ }

      // Also check for a link appearing in the current page
      try {
        const linkEl = await page.$('a[href*="docs.google.com/presentation"], a[href*="slides.google.com"]');
        if (linkEl) {
          const href = await linkEl.getAttribute("href");
          log.success(`  ✅ Presentation link found: ${href}`);
          await sendProgress?.("Presentation generated successfully!", 6, 6);
          return {
            status: "success",
            presentation_url: href ?? undefined,
            message: `Presentation is ready: ${href}`,
          };
        }
      } catch { /* continue polling */ }

      // Check for loading/progress indicator to know if still generating
      try {
        const progressEl = await page.$('.presentation-generating, [data-testid="presentation-loading"], mat-progress-bar');
        if (!progressEl) {
          // No loader visible — may have finished without a detectable link
          log.warning("  ⚠️  No progress indicator found, checking for completion...");
        }
      } catch { /* ignore */ }
    }

    return {
      status: "timeout",
      message:
        "Presentation generation timed out (>4 min). " +
        "Check your NotebookLM notebook directly — it may still be generating in the Estúdio tab.",
    };
  }

  /**
   * Poll for audio overview completion and return the audio URL.
   * Audio generation typically takes 2–5 minutes.
   */
  private async waitForAudioOverview(
    page: Page,
    sendProgress?: ProgressCallback
  ): Promise<{ status: string; audio_url?: string; message?: string }> {
    const timeoutMs = 8 * 60 * 1000; // 8 minutes
    const pollMs = 10_000;
    const start = Date.now();
    let dots = 0;

    log.info("  ⏳ Waiting for audio overview generation...");

    while (Date.now() - start < timeoutMs) {
      await randomDelay(pollMs - 1000, pollMs + 1000);
      dots++;
      const elapsed = Math.round((Date.now() - start) / 1000);
      await sendProgress?.(
        `Generating audio overview... ${elapsed}s elapsed (typically 2–5 min)`,
        3,
        6
      );

      // Check for audio player appearing
      const audioSelectors = [
        'audio',
        '[data-testid="audio-player"]',
        'button[aria-label="Play audio overview"]',
        '.audio-overview-player',
        'button:has-text("Play")',
      ];

      for (const sel of audioSelectors) {
        try {
          const el = await page.$(sel);
          if (el && (await el.isVisible())) {
            // Try to extract src if it's an <audio> element
            let audioUrl: string | undefined;
            try {
              audioUrl = await page.$eval('audio', (a: any) => a.src) as string;
            } catch { /* no direct audio src */ }

            log.success("  ✅ Audio overview is ready!");
            await sendProgress?.("Audio overview generated successfully!", 6, 6);
            return {
              status: "success",
              audio_url: audioUrl,
              message: audioUrl
                ? `Audio overview ready. URL: ${audioUrl}`
                : "Audio overview is ready in the Notebook Guide panel. Open your notebook to listen.",
            };
          }
        } catch { continue; }
      }

      // Check for error state
      try {
        const errorEl = await page.$('.audio-error, [data-testid="audio-error"]');
        if (errorEl && (await errorEl.isVisible())) {
          const errorText = await errorEl.innerText();
          throw new Error(`Audio overview generation failed: ${errorText}`);
        }
      } catch (e: any) {
        if (e.message.startsWith("Audio overview generation failed")) throw e;
      }
    }

    return {
      status: "timeout",
      message:
        "Audio overview generation is taking longer than expected (>8 min). " +
        "Check your notebook in a browser — it may still be generating.",
    };
  }

  /**
   * Wait for generated text content (study guide, briefing doc, FAQ, timeline)
   * to appear in the Notebook Guide panel.
   */
  private async waitForGeneratedText(
    page: Page,
    type: string,
    sendProgress?: ProgressCallback
  ): Promise<{ status: string; content?: string; message?: string }> {
    const timeoutMs = 3 * 60 * 1000; // 3 minutes
    const pollMs = 3_000;
    const start = Date.now();

    const contentSelectors = [
      '.notebook-guide-content',
      '[data-testid="guide-content"]',
      '.guide-panel-content',
      '.notebook-overview-content',
      // Generic fallback: large text block that appeared after the click
      '.generated-content',
      'mat-dialog-content',
      '[role="document"] .content',
    ];

    log.info(`  ⏳ Waiting for ${type} content...`);

    while (Date.now() - start < timeoutMs) {
      await randomDelay(pollMs - 500, pollMs + 500);
      const elapsed = Math.round((Date.now() - start) / 1000);
      await sendProgress?.(`Generating ${type}... ${elapsed}s elapsed`, 4, 6);

      for (const sel of contentSelectors) {
        try {
          const el = await page.$(sel);
          if (el && (await el.isVisible())) {
            const text = (await el.innerText()).trim();
            if (text.length > 100) {
              log.success(`  ✅ ${type} content ready (${text.length} chars)`);
              await sendProgress?.(`${type} generated successfully!`, 6, 6);
              return { status: "success", content: text };
            }
          }
        } catch { continue; }
      }
    }

    return {
      status: "timeout",
      message:
        `${type} generation timed out (>3 min). ` +
        "The content may still be generating — check your notebook directly.",
    };
  }

  /**
   * Close the session
   */
  async close(): Promise<void> {
    log.info(`🛑 Closing session ${this.sessionId}...`);

    if (this.page) {
      try {
        await this.page.close();
        this.page = null;
        log.success(`  ✅ Page closed`);
      } catch (error) {
        log.warning(`  ⚠️  Error closing page: ${error}`);
      }
    }

    this.initialized = false;
    log.success(`✅ Session ${this.sessionId} closed`);
  }

  /**
   * Update last activity timestamp
   */
  updateActivity(): void {
    this.lastActivity = Date.now();
  }

  /**
   * Check if session has expired (inactive for too long)
   */
  isExpired(timeoutSeconds: number): boolean {
    const inactiveSeconds = (Date.now() - this.lastActivity) / 1000;
    return inactiveSeconds > timeoutSeconds;
  }

  /**
   * Get session information
   */
  getInfo(): SessionInfo {
    const now = Date.now();
    return {
      id: this.sessionId,
      created_at: this.createdAt,
      last_activity: this.lastActivity,
      age_seconds: (now - this.createdAt) / 1000,
      inactive_seconds: (now - this.lastActivity) / 1000,
      message_count: this.messageCount,
      notebook_url: this.notebookUrl,
    };
  }

  /**
   * Get the underlying page (for advanced operations)
   */
  getPage(): Page | null {
    return this.page;
  }

  /**
   * Check if session is initialized
   */
  isInitialized(): boolean {
    return this.initialized && this.page !== null;
  }
}
