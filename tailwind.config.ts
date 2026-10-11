import type { Config } from 'tailwindcss';

/**
 * Design system tokens.
 *
 * This is the single source of truth for color, type, radius, shadow and
 * motion across the app. Components should reference these tokens
 * (bg-surface, rounded-control, shadow-composer, etc.) rather than
 * introducing arbitrary CSS values.
 */
const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'var(--color-background)',
        foreground: 'var(--color-foreground)',
        surface: 'var(--color-surface)',
        'surface-hover': 'var(--color-surface-hover)',
        'surface-raised': 'var(--color-surface-raised)',
        border: 'var(--color-border)',
        'border-strong': 'var(--color-border-strong)',
        accent: 'var(--color-accent)',
        'accent-foreground': 'var(--color-accent-foreground)',
        'accent-muted': 'var(--color-accent-muted)',
        secondary: 'var(--color-secondary)',
        'secondary-muted': 'var(--color-secondary-muted)',
        muted: 'var(--color-muted)',
        danger: 'var(--color-danger)',
        success: 'var(--color-success)',
        // Legacy aliases kept so existing components using primary/* still compile.
        primary: 'var(--color-accent)',
        'primary-foreground': 'var(--color-accent-foreground)',
      },
      fontFamily: {
        display: ['var(--font-display)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['var(--font-body)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        xs: ['0.75rem', { lineHeight: '1.1rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.9375rem', { lineHeight: '1.5rem' }],
        lg: ['1.0625rem', { lineHeight: '1.6rem' }],
        xl: ['1.25rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.625rem', { lineHeight: '2rem' }],
        '3xl': ['2.125rem', { lineHeight: '2.5rem' }],
      },
      borderRadius: {
        control: '8px',
        surface: '16px',
      },
      boxShadow: {
        composer: '0 1px 2px rgba(0,0,0,0.04), 0 8px 24px -8px rgba(0,0,0,0.12)',
        popover: '0 4px 16px -4px rgba(0,0,0,0.18)',
      },
      transitionDuration: {
        fast: '120ms',
        base: '180ms',
      },
      transitionTimingFunction: {
        signal: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
      zIndex: {
        nav: '20',
        overlay: '30',
        dropdown: '40',
        modal: '50',
      },
      keyframes: {
        'rise-in': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulse-dot: {
          '0%, 80%, 100%': { opacity: '0.25' },
          '40%': { opacity: '1' },
        },
      },
      animation: {
        'rise-in': 'rise-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        'pulse-dot': 'pulse-dot 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
