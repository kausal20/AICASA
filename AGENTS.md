# UI implementation guidance

When designing or implementing UI, first check whether an appropriate Skiper UI component can improve the interaction. Prefer installed Skiper components for suitable animated links and small motion patterns, while keeping AICASA tokens, accessibility, responsive behavior, reduced-motion support, and clear language. Do not force a component where it distracts from administrative work. Free Skiper components require attribution; preserve source comments and provide visible credit when the license requires it. The project uses Vite, React Router, Tailwind, and `motion/react`, not Next.js. Adapt registry examples to React Router and project aliases before use.

Installed component: `src/components/ui/skiper40.tsx` (Skiper40 CSS link animations). Use its router-aware Link000–Link005 exports. Source: https://skiper-ui.com/v1/skiper40. Check sources and licenses before adding components; some have paid terms or new runtime dependencies.
