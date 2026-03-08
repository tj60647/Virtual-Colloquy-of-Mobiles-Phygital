# Colloquy of Mobiles Virtual Simulation — Phygital — Agent Instructions

This project is in a prototyping phase.

## Repository Layout

- `firmware/` — PlatformIO ESP32 firmware (runs on the physical device). See `firmware/AGENTS.md` for firmware-specific rules.
- `dashboard/` — Next.js web app (browser UI / WebSerial host). See `dashboard/AGENTS.md` for dashboard-specific rules.

Both subprojects have their own `AGENTS.md` that extends these shared rules.

## Audience
- Primary audience includes design students with little or no coding/electronics background.
- Prefer plain-language explanations and avoid jargon unless terms are explained.
- Make status output and docs instructional, not only diagnostic.

## Goals
- Move quickly and verify hardware behavior incrementally.
- Prefer readable code and rich debug output over heavy optimization.
- Keep decisions reversible until hardware behavior is validated.

## Author And License
- Author: Thomas J McLeish
- License: MIT
- New source files should include a file header with the project name, author, and MIT license reference.
- Each subproject's `AGENTS.md` defines the language-appropriate header format.

## General Commenting Convention
- Comment verbosely enough that intent, assumptions, and behavior are obvious.
- Explain "why" and design decisions, not only "what".
- Keep comments current when behavior changes.
- When possible, phrase comments so non-programmers can infer system behavior.

## Scope Priority
- Prioritize proving behavior over architecture purity.
- Add abstractions only when repetition or complexity justifies them.
- Keep decisions reversible until behavior is validated.