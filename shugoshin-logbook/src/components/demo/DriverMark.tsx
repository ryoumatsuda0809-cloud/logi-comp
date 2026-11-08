/**
 * シートの上に出す、ドライバー向けの小さな絵（トラックに、話題の印を載せたもの）。
 * 色は守護神の濃紺とオレンジだけ。絵は SVG なので、画像ファイルは増えない。
 */
export type DriverGlyph = "clock" | "pin" | "lock" | "layers";

function Glyph({ kind }: { kind: DriverGlyph }) {
  // 荷台（オレンジ）の中央 (70, 66) に、白い印を描く
  const common = { fill: "none", stroke: "#fff", strokeWidth: 6, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  switch (kind) {
    case "clock":
      return (
        <g {...common}>
          <circle cx="70" cy="66" r="21" />
          <path d="M70 54v13l9 6" />
        </g>
      );
    case "pin":
      return (
        <g {...common}>
          <path d="M70 90s-20-17-20-33a20 20 0 0 1 40 0c0 16-20 33-20 33z" transform="translate(0 -6)" />
          <circle cx="70" cy="51" r="6" fill="#fff" stroke="none" />
        </g>
      );
    case "lock":
      return (
        <g {...common}>
          <rect x="52" y="62" width="36" height="26" rx="6" />
          <path d="M59 62v-8a11 11 0 0 1 22 0v8" />
        </g>
      );
    case "layers":
      return (
        <g {...common}>
          <path d="M70 46l22 11-22 11-22-11z" />
          <path d="M48 69l22 11 22-11" />
        </g>
      );
  }
}

export function DriverMark({ glyph, className = "" }: { glyph: DriverGlyph; className?: string }) {
  return (
    <svg viewBox="0 0 200 130" className={className} role="img" aria-label="ドライバーのトラック">
      {/* 地面 */}
      <rect x="8" y="112" width="184" height="5" rx="2.5" className="fill-accent/25" />
      {/* 荷台 */}
      <rect x="22" y="26" width="96" height="76" rx="10" className="fill-accent" />
      {/* 運転席 */}
      <path d="M122 48h32a8 8 0 0 1 6 3l18 24a8 8 0 0 1 2 5v22h-58z" className="fill-primary" />
      <path d="M130 56h22l14 19h-36z" fill="#fff" fillOpacity="0.85" />
      {/* 車輪 */}
      <circle cx="56" cy="104" r="14" className="fill-primary" />
      <circle cx="56" cy="104" r="5.5" fill="#fff" />
      <circle cx="152" cy="104" r="14" className="fill-primary" />
      <circle cx="152" cy="104" r="5.5" fill="#fff" />
      <Glyph kind={glyph} />
    </svg>
  );
}

/** 魚1匹の形（頭が左）。色は currentColor。 */
function Fish({ x, y, scale = 1, rotate = 0, flip = false }: { x: number; y: number; scale?: number; rotate?: number; flip?: boolean }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${flip ? -scale : scale} ${scale})`}>
      <path d="M0 30C20 4 74 4 96 30C74 56 20 56 0 30Z" fill="currentColor" />
      <path d="M92 30L118 10L111 30L118 50Z" fill="currentColor" />
      <circle cx="24" cy="26" r="3.5" fill="#fff" />
    </g>
  );
}

/**
 * 背景にうっすら泳ぐ魚。色は currentColor（呼び出し側で薄くする）。
 * 飾りなので、読み上げず、押せず、印刷にも出さない。
 */
export function FishScatter({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 280 170" className={`pointer-events-none select-none print:hidden ${className}`} aria-hidden>
      <Fish x={120} y={6} scale={1.15} rotate={-8} />
      <Fish x={38} y={78} scale={0.78} rotate={6} />
      <Fish x={206} y={104} scale={0.58} rotate={-4} flip />
      <circle cx="26" cy="40" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="58" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="262" cy="86" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
