# Changelog

## 1.0.0 (2026-10-20)

First release.

- Courses from PDF, DOCX, EPUB, Markdown, HTML and text, with page and chapter locations.
- Concept maps in prerequisite order, built by any OpenAI-compatible model.
- Grounding enforced in code: concepts, questions and Ask answers must quote the material; unverifiable items are discarded and counted.
- Multiple-choice, true/false and short-answer questions; code grading for choice questions, key-point grading with feedback for short answers; Socratic hints that can't leak the answer.
- FSRS-6 spaced repetition, verified against the reference implementation; mastery gating and a stricter "mastered" status based on retention.
- Local web app (Study, Map, Ask, Material, Progress) and a full CLI, including terminal study.
- Exports to Anki and to a Markdown study guide.
- Finds a running freeflow gateway or Ollama automatically.
