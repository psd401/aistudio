# Pedagogy Rubric — the learning-science spec this page must satisfy

Read this before authoring `--content-json` (learning targets, summary, quiz, narration) or
tuning the generated page. These evidence bases drive the design; the concrete rules below
are what "good" means here. When you author content, apply them — the built-in deterministic
derivation is a safe fallback, not a substitute for real instructional design.

## UDL 3.0 (CAST, 2024) — provide multiple means of…
- **Engagement (the "why")**: open with *why this matters to you* and *when you'll use it*
  (a relevance hook). Offer a choice of modality. Keep segments short. Use inclusive, plain,
  identity-affirming language (3.0's added emphasis on belonging + reducing bias).
- **Representation (the "what")**: the *same* content as video, audio, text, and summary so a
  learner picks their path. Define key terms before using them.
- **Action & Expression (the "how")**: the quiz + self-check let the learner act on and
  demonstrate understanding.

## Mayer — Cognitive Theory of Multimedia Learning (honor in video + audio)
- **Multimedia**: words + visuals, not words alone.
- **Coherence**: cut extraneous detail, music, and decoration.
- **Signaling**: cue the key ideas.
- **Redundancy**: do NOT put on-screen text that duplicates the narration word-for-word.
- **Segmenting**: short, learner-paced chunks.
- **Pre-training**: define key terms first.
- **Modality**: narrate visuals rather than a wall of on-screen text.
- **Personalization**: conversational, first-person/second-person voice.
- **Voice**: a natural TTS voice (`psd-tts --engine long-form`).

## Adult learning / andragogy (Knowles)
Adults are self-directed, bring experience, and need immediate relevance and problem-centered
framing. So: lead with relevance, use real district scenarios, let the learner navigate
non-linearly, and respect their time (a concise summary + the option to go deep).

## Retrieval practice & the testing effect (the quiz is not decoration)
- Active recall **with immediate feedback** produces durable learning.
- Every multiple-choice item gives **feedback + a short rationale**: why the right answer is
  right and (ideally) why the distractors are wrong. MC *without* feedback can teach errors.
- Prefer **application / scenario** items over pure recall where the content allows.
- Never invent facts: a distractor should be plausible but clearly *not supported by the
  document*, and the correct answer should restate something the document actually says.

## PSD Instructional Essentials (load the `psd-instructional-vision` skill for the full stance)
Align tone + structure to the 4 Essentials — **Rigor & Inclusion, Data-Driven, Continuous
Growth, Innovation** — and Tier-1 practices: clear learning targets in student-friendly
language, scaffolds that maintain rigor, formative self-assessment, real-world connections,
and intentional, accessible use of technology.

## Accessibility — WCAG 2.2 AA (enforced, legal floor)
These pages are district web content (DOJ ADA Title II → WCAG 2.1 AA floor; we target the 2.2
AA superset). The shared `psd-html-artifact` axe gate blocks publish on critical/serious
violations. Build it in, don't bolt it on:
- `<html lang>`, one `<h1>` + ordered semantic headings, landmark regions.
- Real `<button>`/`<a>` controls, keyboard operable, visible `:focus-visible`.
- A name/label on every control **and** media element; `alt` on every image.
- **Captions** on the video (`<track kind="captions">`, WebVTT from the narration, inlined),
  **transcript** for the audio.
- Quiz feedback announced via an `aria-live` region and conveyed by **more than color**
  (a word + a symbol, not hue alone).
- Text/UI contrast ≥ 4.5:1 (3:1 for large text/UI), 200%-zoom / reflow — verified in a real
  browser (the jsdom gate can't compute these two).
- `prefers-reduced-motion` honored; no essential info conveyed only by motion.

## Authoring `--content-json` — shape
```json
{
  "learningTargets": ["I can explain why the acceptable-use rules protect me."],
  "summary": ["Students use district devices for learning.", "…"],
  "quiz": [
    {
      "question": "A student finds a classmate's password on a shared computer. What should they do?",
      "options": ["Log out and tell a teacher", "Use it to check their grades", "Post it in the class chat", "Keep it for later"],
      "answer": 0,
      "rationale": "Protecting credentials and reporting problems is the acceptable-use expectation; the other options misuse another student's account."
    }
  ],
  "narration": { "script": "Welcome. Let's talk about how you use school technology, and why it keeps you and your classmates safe. …" }
}
```
Write **application** items like the example above where the document supports them; fall back
to recognition of key points only when it doesn't.
