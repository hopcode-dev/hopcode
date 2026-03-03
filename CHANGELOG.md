# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Upload button in file browser header
- Session delete functionality
- Multi-user authentication support
- Frog logo (`media/logo.svg`)
- Bar slide animation for bottom bar
- Floating key drag reorder

### Changed
- Repo restructure: split into dual-service architecture (PTY + UI)
- Cleaned up deprecated files, added CI, governance docs, and contributor guides
- Session list redesign with improved UI
- File upload now supports all file types (not just images)
- Cursor state restored on reconnect

### Fixed
- Resize storm causing excessive reflows

## [1.0.0] - 2025-03-01

### Added
- Floating keys with auto-scroll on input/resize
- Clipboard image paste upload with persistent font size
- File browser v2: Finder-style UI, bottom bar redesign, swipe gestures
- Session renaming with edit button and dynamic tab titles
- Hardened server security: WebSocket auth, rate limiting, secure cookies
- Optional Cloudflare Tunnel support for remote access
- Improved voice ASR, mobile UI, and mic management
- Flicker-free reconnect and voice fixes
- Crash protection and reverse proxy login fix
- Mobile-friendly UI, session management, and streaming ASR

### Fixed
- Image upload auth, error handling, and cursor style
- Bar collapse toggle working on desktop, not just mobile
- EPIPE death spiral causing 90% CPU and 1.5s input latency
- Mobile autocomplete duplication after rebrand
