// Where 0 is in each script's run of digits 0–9: ASCII, Arabic-Indic, Persian,
// Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada,
// Malayalam, Thai, Lao, Myanmar, Khmer, full width.
const DIGIT_ZEROS = [
  0x30, 0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6,
  0xd66, 0xe50, 0xed0, 0x1040, 0x17e0, 0xff10,
];

// The text with every digit in 0–9, whatever script it was written in.
export function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (d) => {
    const code = d.codePointAt(0)!;
    const zero = DIGIT_ZEROS.find((z) => code >= z && code <= z + 9);
    return zero === undefined ? d : String(code - zero);
  });
}
