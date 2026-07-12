export function compactLog(lines: string[]) {
  return lines.filter((line) => /error|fail|must|security/i.test(line));
}
