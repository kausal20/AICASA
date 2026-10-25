---
version: alpha
name: AICASA
description: Clear, calm approval management for institutions, officers, and administrators.
colors:
  primary: "#1E3A8A"
  primary-hover: "#172E6E"
  primary-soft: "#E8EDF8"
  primary-ink: "#172554"
  page: "#F3F5F9"
  surface: "#FFFFFF"
  surface-muted: "#EEF1F6"
  surface-sunken: "#E6EAF2"
  line: "#D9DFE8"
  line-strong: "#C4CCDA"
  ink: "#0F172A"
  ink-soft: "#475569"
  ink-faint: "#64748B"
  accent: "#236B9A"
  accent-soft: "#E7F0F7"
  success: "#168568"
  success-soft: "#E5F4EE"
  warning: "#946200"
  warning-soft: "#FBF1DC"
  danger: "#B42318"
  danger-soft: "#FCE9E7"
  info: "#52616B"
  info-soft: "#EDF0F2"
typography:
  sans:
    fontFamily: "Inter, ui-sans-serif, system-ui, Segoe UI, Roboto, sans-serif"
  mono:
    fontFamily: "ui-monospace, monospace"
rounded:
  DEFAULT: "0.25rem"
  lg: "0.5rem"
  card: "0.75rem"
spacing:
  section-gap: "1.5rem"
  page-max: "95rem"
components:
  button: {}
  panel: {}
  dialog: {}
  application-table: {}
  action-queue: {}
---

# AICASA design system

## Overview
The visual reference is a well-organised institutional case file: a clear reference, responsible person, current status, and next step. The signed-out landing page centres a large two-line headline above one wide, interactive application record. Document stacks, a five-stage progress rail, and changing evidence make its connected journey the signature element. Two alternating visual stories explain corrections and coordinated reviews. Product workspaces prioritise readable information and predictable controls.

The audience is Indian institutions, regional officers, and approval administrators, based on the project's SIH26262 brief and role model in README.md. The current interface is English, with IST deadlines. This is a synthetic demonstration, not an official AICTE service. Regulatory vocabulary is supporting context; Applications and named role workspaces are the primary navigation terms.

## Colors
Navy carries primary actions and selected navigation. White panels sit on cool gray pages; borders define groups. Accent blue indicates links. Success, warning and danger always accompany text or an icon, never encode status alone. Metadata uses ink-faint or ink-soft. The current theme is light; forced-colors mode retains native scrollbar behavior.

## Typography
Use the existing Inter/system stack. Product navigation and record text are 14px; supporting metadata is generally 12–13px with at least 1.5 line height. The main workspace base is 15px. Numerals in dates and quantities use tabular spacing. Landing headlines have larger editorial scale; dense product screens retain restrained headings.

## Layout
The desktop shell has a 256px sidebar and a maximum 1520px content area. Below 1024px the sidebar becomes a drawer. Application lists become record cards below 768px. Primary queues occupy the full content width; secondary dashboard information follows beneath. Tables retain reference, institution where relevant, status, deadline and action controls. Optional next-action and age columns are selected explicitly; details expose longer text without squeezing the main row.

Comfortable mode uses 16px vertical row padding; compact uses 10px. Navigation targets are 44px normally and 38px in compact mode. Header controls and row menus remain at least 44px tall. The browser remembers density and optional columns.

## Elevation & Depth
Use subtle existing card/lift shadows and borders for panels. Popover elevation belongs to menus and overlays. Avoid decorative gradients, glass effects, continuous motion, and competing KPI emphasis.

## Shapes
Shared panels use 12px corners, controls typically 8px. Status chips may be rounded. Icons use the existing Lucide set with consistent stroke and adjacent labels where space allows.

## Components
Button.tsx owns primary, secondary, ghost and link actions, with disabled and busy states. Workspace.tsx owns panels, row menus, drawers and segmented controls. Field.tsx owns inputs and native selects. Native details/summary owns row and preference disclosure; checkbox labels provide generous hit areas. Radix owns overlay focus trapping and Escape behavior. Sonner owns operation feedback.

Every remote list supports loading, error/retry, empty and populated states. Filters remain available when a list is empty. Saved views store current filters locally, scoped by account and role. Save and remove feedback use a status message. ApplicationsTable owns desktop sorting, optional columns, full details and mobile cards.

The action queue begins each role dashboard with Act now, Due this week, Waiting on someone else and Recently completed. It is an overview with an explicit bounded preview and total count; applications and their tasks are counted separately. Record links lead to the existing permission-aware workspaces.

## Motion
Use the existing motion/react page and overlay transitions (roughly 160–200ms), with panel entry at 320ms and small 8px movement. The signed-out landing journey advances through five stages every 4.5 seconds while visible. Selecting or focusing a stage pauses it; explicit play/pause controls remain available. Changing documents, short evidence transitions, subtle button motion, and one-time scroll reveals use landing-scoped CSS. Reduced motion disables autoplay and visual transitions. Keep loading geometry stable and avoid animation on every data refresh.

## Runtime ownership and verification
tailwind.config.js and src/index.css are canonical runtime sources; this file mirrors them rather than generating tokens. Shared components are authoritative for states. Changes to palette, density or motion require updating both this record and the runtime, followed by typecheck, lint, build and a desktop/mobile visual check. UX-CONTRACT.md records behavior and sources. Full accessibility certification is outside this implementation's verification scope.
