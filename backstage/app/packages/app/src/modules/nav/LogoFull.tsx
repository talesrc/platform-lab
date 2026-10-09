import { LogoMark, colors } from './logoMark';

/** Open sidebar: mark + "TALECO" wordmark, 30px tall. System fonts, no font files. */
export const LogoFull = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 126 32"
    height={30}
    width={(126 / 32) * 30}
    role="img"
    aria-label="TALECO"
  >
    <LogoMark />
    <text
      x={39}
      y={22.5}
      fontFamily="'Helvetica Neue', Helvetica, Roboto, Arial, sans-serif"
      fontSize={20}
      fontWeight={800}
      letterSpacing={-0.3}
      fill={colors.text}
    >
      TALECO
    </text>
  </svg>
);
