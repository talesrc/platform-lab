/**
 * TALECO mark, "golden path": a T drawn as a route between two nodes, ending in a
 * violet stop. Shared by the sidebar logos; public/ holds the same mark as favicons
 * (safari-pinned-tab.svg is its one-colour silhouette). Colours are the Midnight theme's
 * (modules/theme/midnight.ts).
 */
export const colors = {
  sidebar: '#0a0f19',
  teal: '#2dd4bf',
  violet: '#a78bfa',
  text: '#e6edf6',
};

/** The mark's shapes, on a 32x32 grid. */
export const LogoMark = () => (
  <>
    <path
      d="M6.5 8 H25.5 M16 8 V23.5"
      fill="none"
      stroke={colors.teal}
      strokeWidth={3.4}
      strokeLinecap="round"
    />
    <circle
      cx={6.5}
      cy={8}
      r={3.3}
      fill={colors.sidebar}
      stroke={colors.teal}
      strokeWidth={2.6}
    />
    <circle
      cx={25.5}
      cy={8}
      r={3.3}
      fill={colors.sidebar}
      stroke={colors.teal}
      strokeWidth={2.6}
    />
    <circle cx={16} cy={25.5} r={3.9} fill={colors.violet} />
  </>
);
