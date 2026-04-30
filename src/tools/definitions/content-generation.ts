import { Tool } from "@modelcontextprotocol/sdk/types.js";

export const contentGenerationTools: Tool[] = [
  {
    name: "generate_audio_overview",
    description: `# Generate Audio Overview (NotebookLM Podcast)

Triggers NotebookLM's Audio Overview feature — the "podcast" with two AI hosts discussing your notebook sources. Returns status and a download URL when ready.

## When to use
- User wants a podcast/audio summary of the notebook
- User wants to listen to the content instead of reading
- Sharing research with non-technical stakeholders via audio

## Notes
- Generation takes 2–5 minutes; the tool polls until complete or times out (8 min)
- Audio is only available while the notebook URL session is active
- Requires an active, authenticated session`,
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: {
          type: "string",
          description: "Library notebook ID. If omitted, uses the active notebook.",
        },
        notebook_url: {
          type: "string",
          description: "Direct notebook URL (overrides notebook_id).",
        },
        customization: {
          type: "object",
          description: "Optional customization for the audio overview.",
          properties: {
            focus: {
              type: "string",
              description: "Specific topic or angle to focus on (e.g. 'focus on the methodology section').",
            },
            style: {
              type: "string",
              enum: ["default", "deep_dive", "brief"],
              description: "Conversation style. 'deep_dive' goes longer and more technical, 'brief' is a quick summary.",
            },
          },
        },
        show_browser: {
          type: "boolean",
          description: "Show the browser window (useful for debugging).",
        },
      },
      required: [],
    },
  },
  {
    name: "generate_study_guide",
    description: `# Generate Study Guide

Uses NotebookLM's built-in Study Guide generation to create a structured guide from notebook sources. Returns the full text of the study guide.

## When to use
- User wants a structured summary with key concepts, definitions, and questions
- Preparing for a presentation or review session
- Onboarding someone new to the material`,
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: {
          type: "string",
          description: "Library notebook ID. If omitted, uses the active notebook.",
        },
        notebook_url: {
          type: "string",
          description: "Direct notebook URL (overrides notebook_id).",
        },
        show_browser: {
          type: "boolean",
          description: "Show the browser window (useful for debugging).",
        },
      },
      required: [],
    },
  },
  {
    name: "generate_briefing_doc",
    description: `# Generate Briefing Document

Uses NotebookLM's Briefing Doc feature to create a concise executive summary of the notebook sources. Returns the full briefing text.

## When to use
- User needs a quick executive summary of a large body of research
- Preparing a brief for stakeholders or leadership
- Getting the "bottom line up front" from multiple sources`,
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: {
          type: "string",
          description: "Library notebook ID. If omitted, uses the active notebook.",
        },
        notebook_url: {
          type: "string",
          description: "Direct notebook URL (overrides notebook_id).",
        },
        show_browser: {
          type: "boolean",
          description: "Show the browser window (useful for debugging).",
        },
      },
      required: [],
    },
  },
  {
    name: "generate_faq",
    description: `# Generate FAQ

Uses NotebookLM's FAQ generation to extract the most common questions and answers from notebook sources.

## When to use
- User wants to understand what questions the content answers
- Building a knowledge base or help center from research
- Quick way to surface the key points in Q&A format`,
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: {
          type: "string",
          description: "Library notebook ID. If omitted, uses the active notebook.",
        },
        notebook_url: {
          type: "string",
          description: "Direct notebook URL (overrides notebook_id).",
        },
        show_browser: {
          type: "boolean",
          description: "Show the browser window (useful for debugging).",
        },
      },
      required: [],
    },
  },
  {
    name: "generate_timeline",
    description: `# Generate Timeline

Uses NotebookLM's Timeline feature to extract and organize chronological events from notebook sources.

## When to use
- User wants a chronological view of events in the content
- Historical research, project retrospectives, or sequential processes
- Organizing facts by date or sequence`,
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: {
          type: "string",
          description: "Library notebook ID. If omitted, uses the active notebook.",
        },
        notebook_url: {
          type: "string",
          description: "Direct notebook URL (overrides notebook_id).",
        },
        show_browser: {
          type: "boolean",
          description: "Show the browser window (useful for debugging).",
        },
      },
      required: [],
    },
  },
  {
    name: "generate_presentation",
    description: `# Generate Slide Presentation (Apresentação de slides)

Triggers NotebookLM's "Apresentação de slides" feature in the Estúdio tab, which generates a Google Slides-style presentation from notebook sources. Polls until the presentation is ready and returns a link to open it.

## When to use
- User wants a slide deck from the notebook content
- Preparing a presentation for stakeholders, classes, or meetings
- Structuring research as slides automatically

## Notes
- Generation takes 1–3 minutes
- The result opens as a Google Slides presentation
- Requires the "Estúdio" tab to be available in your NotebookLM account`,
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: {
          type: "string",
          description: "Library notebook ID. If omitted, uses the active notebook.",
        },
        notebook_url: {
          type: "string",
          description: "Direct notebook URL (overrides notebook_id).",
        },
        show_browser: {
          type: "boolean",
          description: "Show the browser window (useful for debugging).",
        },
      },
      required: [],
    },
  },
];
