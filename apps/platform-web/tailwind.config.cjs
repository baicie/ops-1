const token = (name) => `var(--${name})`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // Semantic utilities follow html[data-theme="dark"] through the CSS variables, so the
  // class strategy is only a convenience for the few places that need an explicit dark: rule.
  darkMode: ['class', '[data-theme="dark"]'],
  // preflight is disabled on purpose: src/styles.css already ships the global reset plus
  // control typography for the 20 pages that have not been migrated yet. Re-normalising
  // headings/lists/tables/forms in one shot would be the big-bang rewrite rules/06 forbids.
  // Copy-in components therefore carry their own border-style/border-width classes.
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        background: token('ow-bg'),
        foreground: token('ow-text'),
        'foreground-secondary': token('ow-text-secondary'),
        card: { DEFAULT: token('ow-surface'), foreground: token('ow-text') },
        popover: { DEFAULT: token('ow-surface'), foreground: token('ow-text') },
        primary: { DEFAULT: token('ow-accent'), foreground: token('ow-accent-text') },
        secondary: { DEFAULT: token('ow-surface-2'), foreground: token('ow-text') },
        muted: { DEFAULT: token('ow-surface-2'), foreground: token('ow-text-muted') },
        accent: { DEFAULT: token('ow-accent-soft'), foreground: token('ow-accent') },
        destructive: { DEFAULT: token('ow-danger'), foreground: '#ffffff', soft: token('ow-danger-soft') },
        success: { DEFAULT: token('ow-ok'), soft: token('ow-ok-soft') },
        warning: { DEFAULT: token('ow-warn'), soft: token('ow-warn-soft') },
        info: { DEFAULT: token('ow-info'), soft: token('ow-info-soft') },
        border: token('ow-border'),
        'border-strong': token('ow-border-strong'),
        input: token('ow-border-strong'),
        ring: token('ow-focus'),
        surface: { DEFAULT: token('ow-surface'), 2: token('ow-surface-2'), 3: token('ow-surface-3') },
      },
      // token-table R3: exactly two control heights, and the Tailwind scale names the TIER
      // instead of a number. The copy-in primitives were written with shadcn's h-9 (36px),
      // h-7 (28px) and h-11 (44px) — three heights that are none of the two tiers, which is
      // how /admin/jobs put a 36px input, a 36px select and a 28px tab trigger on one line
      // (an 8px baseline break inside a single row). `h-control-sm` and `h-control-md` read
      // the same tokens as .btn and the global input rule, so a shadcn Button and a legacy
      // .btn are now the same box.
      height: {
        "control-sm": token("ow-control-sm"),
        "control-md": token("ow-control-md"),
      },
      width: {
        "control-sm": token("ow-control-sm"),
        "control-md": token("ow-control-md"),
      },
      minHeight: {
        "control-sm": token("ow-control-sm"),
        "control-md": token("ow-control-md"),
      },
      borderRadius: {
        // token-table R1: three tiers, named by the JOB they dress, not by a t-shirt size.
        // The shadcn copy-ins arrived with rounded-md / rounded-sm / rounded-lg, which is a
        // fourth radius vocabulary sitting on top of the three tokens: "md" says nothing about
        // whether the box is a control or a card, so the next primitive guesses. These three
        // names cannot be guessed wrong, and the gate can read them.
        control: token("ow-radius-control"),
        card: token("ow-radius-card"),
        pill: "9999px",
        // The size aliases stay, pointed at the same tiers, so any utility this repo has not
        // migrated renders the tier instead of a fourth value.
        sm: token("ow-radius-control"),
        md: token("ow-radius-control"),
        lg: token("ow-radius-card"),
        full: "9999px",
      },
      boxShadow: { card: token('ow-shadow') },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      fontSize: {
        xs: token('ow-type-xs'),
        sm: token('ow-type-sm'),
        base: token('ow-type-base'),
        lg: token('ow-type-lg'),
        xl: token('ow-type-xl'),
      },
    },
  },
  plugins: [],
};
