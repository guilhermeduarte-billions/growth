import { Tool } from "@modelcontextprotocol/sdk/types.js";

export const sourceManagementTools: Tool[] = [
  {
    name: "source_add",
    description: `# Add Source To NotebookLM

Adds a source to an existing NotebookLM notebook. Supports URL, YouTube URL, pasted text, and local file upload.

## When to use
- User wants to add a web page, YouTube video, text snippet, or local file to a notebook
- You need to ground future NotebookLM answers in new material
- You want to avoid asking the user to manually open NotebookLM and paste the source

## Safety
- This modifies the target NotebookLM notebook by adding a source
- It does not delete or replace existing sources
- For file sources, the file path must point to an existing local file`,
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: {
          type: "string",
          description: "Library notebook ID. If omitted, uses notebook_url or the active notebook.",
        },
        notebook_url: {
          type: "string",
          description: "Direct NotebookLM notebook URL. Overrides notebook_id.",
        },
        source_type: {
          type: "string",
          enum: ["url", "youtube", "text", "file"],
          description: "Source kind to add.",
        },
        url: {
          type: "string",
          description: "URL to add. Required for source_type=url or source_type=youtube.",
        },
        text: {
          type: "string",
          description: "Text content to add. Required for source_type=text.",
        },
        file_path: {
          type: "string",
          description: "Absolute local path. Required for source_type=file.",
        },
        title: {
          type: "string",
          description: "Optional human-readable title for text/file sources.",
        },
        wait: {
          type: "boolean",
          description: "Wait for the source title/URL to appear in the notebook source list. Default: true.",
        },
        show_browser: {
          type: "boolean",
          description: "Show the browser window for debugging.",
        },
      },
      required: ["source_type"],
    },
  },
  {
    name: "source_list",
    description: `# List NotebookLM Sources

Extracts the visible source list from the current NotebookLM notebook.

## When to use
- Verify whether a source was added successfully
- Check what material is currently grounding a notebook
- Inspect source processing status after adding a URL, text, YouTube video, or file

## Notes
- This reads the visible NotebookLM UI, so source metadata depends on what Google renders in the page
- It does not modify the notebook`,
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: {
          type: "string",
          description: "Library notebook ID. If omitted, uses notebook_url or the active notebook.",
        },
        notebook_url: {
          type: "string",
          description: "Direct NotebookLM notebook URL. Overrides notebook_id.",
        },
        show_browser: {
          type: "boolean",
          description: "Show the browser window for debugging.",
        },
      },
      required: [],
    },
  },
  {
    name: "notebooklm_upload_source",
    description: `# Upload Source To NotebookLM

Uploads a local file into an existing NotebookLM notebook using the authenticated browser session.

## When to use
- A local workflow generated a Markdown/PDF/text digest that should become a NotebookLM source
- The user provided a notebook URL or selected a notebook from the library
- You need NotebookLM to ground future answers in a newly generated local file

## Safety
- This modifies the target NotebookLM notebook by adding a source
- It does not delete or replace existing sources
- The file path must point to an existing local file`,
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: {
          type: "string",
          description: "Library notebook ID. If omitted, uses notebook_url or the active notebook.",
        },
        notebook_url: {
          type: "string",
          description: "Direct NotebookLM notebook URL. Overrides notebook_id.",
        },
        file_path: {
          type: "string",
          description: "Absolute local path to the file that should be uploaded as a source.",
        },
        source_title: {
          type: "string",
          description: "Human-readable source title to verify after upload.",
        },
        show_browser: {
          type: "boolean",
          description: "Show the browser window for debugging.",
        },
      },
      required: ["file_path", "source_title"],
    },
  },
];
