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
      borderRadius: {
        sm: token('ow-radius-sm'),
        md: token('ow-radius-md'),
        lg: token('ow-radius-lg'),
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
