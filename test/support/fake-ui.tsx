// A plain stand-in for Safelight's UI kit (api.ui): real elements, no styling,
// so a test can find controls by role and label and drive them.

import * as React from "react";
import type { SafelightAPI } from "../../src/safelight";

export const confirmed: { titles: string[]; answer: boolean } = { titles: [], answer: true };

export const fakeUi: SafelightAPI["ui"] = {
  Button: ({ variant: _v, size: _s, active: _a, full: _f, children, ...rest }) => <button {...rest}>{children}</button>,
  Select: ({ value, onChange, options, ariaLabel }) => (
    <select value={value} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)}>
      {(options ?? []).map((o) => (
        <option key={o.value} value={o.value}>
          {String(o.label)}
        </option>
      ))}
    </select>
  ),
  TextInput: ({ value, onChange, ...rest }) => <input value={value} onChange={(e) => onChange(e.target.value)} {...rest} />,
  NumberInput: ({ value, onChange, width: _w, ...rest }) => (
    <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} {...rest} />
  ),
  TextArea: ({ value, onChange, mono: _m, ...rest }) => <textarea value={value} onChange={(e) => onChange(e.target.value)} {...rest} />,
  Toggle: ({ checked, onChange, label, ariaLabel }) => (
    <label>
      <input type="checkbox" checked={checked} aria-label={ariaLabel} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  ),
  SegmentedControl: ({ value, onChange, options }) => (
    <div role="group">
      {options.map((o) => (
        <button key={o.value} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  ),
  Field: ({ label, hint, children }) => (
    <div>
      {label != null && <span>{label}</span>}
      {children}
      {hint != null && <p>{hint}</p>}
    </div>
  ),
  Section: ({ title, right, children }) => (
    <section>
      <h3>{title}</h3>
      {right}
      {children}
    </section>
  ),
  Card: ({ children }) => <div>{children}</div>,
  Badge: ({ children }) => <span>{children}</span>,
  ProgressBar: ({ value }) => <progress value={value} />,
  Stack: ({ children }) => <div>{children}</div>,
  Row: ({ children }) => <div>{children}</div>,
  tokens: {
    surface0: "var(--color-surface-0)",
    surface1: "var(--color-surface-1)",
    surface2: "var(--color-surface-2)",
    surface3: "var(--color-surface-3)",
    surface4: "var(--color-surface-4)",
    border: "var(--color-border)",
    borderSubtle: "var(--color-border-subtle)",
    textPrimary: "var(--color-text-primary)",
    textSecondary: "var(--color-text-secondary)",
    textMuted: "var(--color-text-muted)",
    accent: "var(--color-accent)",
    accentHover: "var(--color-accent-hover)",
    sliderFill: "var(--color-slider-fill)",
    rating: "var(--color-rating)",
    labelRed: "var(--color-label-red)",
    labelYellow: "var(--color-label-yellow)",
    labelGreen: "var(--color-label-green)",
    labelBlue: "var(--color-label-blue)",
    labelPurple: "var(--color-label-purple)",
    white: "var(--color-white)",
    fontMono: "var(--font-mono)",
    fontCode: "var(--font-code)",
  },
  confirmDialog: async ({ title }) => {
    confirmed.titles.push(title);
    return confirmed.answer;
  },
  alertDialog: async () => {},
  onEscape: () => () => {},
};
