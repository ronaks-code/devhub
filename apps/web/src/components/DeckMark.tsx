/**
 * DeckMark — the DevHub "Deck" brand mark: three fanned session panels in the
 * Nebula scheme (indigo #818CF8 → magenta #E879F9). This is the CHROME CUT of the
 * mark (deck-mark-chrome.svg): simplified fills + bold light edges, drawn for the
 * 16-26px sizes the app chrome uses (sidebar rail, top bar, auth gate, welcome).
 *
 * Inline SVG (not an <img>) so it ships with the bundle, needs no asset request,
 * and can be sized by the caller. The full-detail cut + app-icon variants live in
 * the icon pipeline (public/icon.svg, src-tauri/icons), not here.
 */
export function DeckMark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      width={size}
      height={size}
      role="img"
      aria-hidden
      className={className}
    >
      <g transform="rotate(-17 24 43)">
        <rect x="12.5" y="13" width="23" height="17" rx="4.5" fill="#6E7BF7" opacity=".95" />
        <rect x="12.5" y="13" width="23" height="17" rx="4.5" fill="none" stroke="#C9CFFF" strokeOpacity=".85" strokeWidth="2" />
      </g>
      <g>
        <rect x="12.5" y="11" width="23" height="17" rx="4.5" fill="#A855F7" opacity=".97" />
        <rect x="12.5" y="11" width="23" height="17" rx="4.5" fill="none" stroke="#DFC9FF" strokeOpacity=".9" strokeWidth="2" />
      </g>
      <g transform="rotate(17 24 43)">
        <rect x="12.5" y="13" width="23" height="17" rx="4.5" fill="#EC6BF0" />
        <rect x="12.5" y="13" width="23" height="17" rx="4.5" fill="none" stroke="#FAD4FF" strokeOpacity=".95" strokeWidth="2.2" />
      </g>
    </svg>
  );
}
