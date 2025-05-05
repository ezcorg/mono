
export const detectIndentationUnit = (content: string, limit: number = 1024): string | null => {
    const lines = content.split(/\r?\n/, limit).filter(line => line.trim().length > 0);
    const indentCounts: Record<string, number> = {};
    let indentation = new Set<string>();
    let tabLineCount = 0;
    let spaceLineCount = 0;
    let unit = '\t';

    for (const line of lines) {
        const match = line.match(/^(\s+)/);
        if (!match) continue;

        const indent = match[0];
        const isTab = indent.includes('\t');

        if (isTab) {
            tabLineCount++;
        } else {
            spaceLineCount++;
        }

        indentation.add(indent);
        indentCounts[indent] = (indentCounts[indent] || 0) + 1;
    }

    if (Object.keys(indentCounts).length === 0) {
        return null;
    }

    unit = tabLineCount > spaceLineCount ? '\t' : ' ';

    const counts = Array.from(indentation)
        .filter(indent => indent.startsWith(unit))
        .map(indent => indent.length);

    if (counts.length > 0) {
        const gcd = (...numbers: number[]): number => {
            return numbers.reduce((a, b) => (b === 0 ? a : gcd(b, a % b)));
        };
        const commonUnit = gcd(...counts);
        return unit.repeat(commonUnit);
    }

    return null;
};
