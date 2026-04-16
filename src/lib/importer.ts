import type { Deck, Flashcard, ImportFieldKey, ParsedImport } from "../types";
import { createId } from "./ids";

function detectDelimiter(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  if (firstLine.includes("\t")) {
    return "\t";
  }

  if (firstLine.includes("|")) {
    return "|";
  }

  return ",";
}

function parseDelimitedRows(content: string, delimiter: string): string[][] {
  if (delimiter !== ",") {
    return content.split(/\r?\n/).map((line) => line.split(delimiter));
  }

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const nextCharacter = content[index + 1];

    if (character === '"') {
      if (inQuotes && nextCharacter === '"') {
        currentCell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && character === delimiter) {
      currentRow.push(currentCell);
      currentCell = "";
      continue;
    }

    if (!inQuotes && (character === "\n" || character === "\r")) {
      if (character === "\r" && nextCharacter === "\n") {
        index += 1;
      }

      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = "";
      continue;
    }

    currentCell += character;
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  return rows;
}

function parseDelimited(content: string, delimiter: string): ParsedImport {
  const rows = parseDelimitedRows(content, delimiter)
    .map((row) => row.map((cell) => cell.trim()))
    .filter((row) => row.some((cell) => cell.length > 0));

  if (rows.length === 0) {
    throw new Error("No rows found in the imported content.");
  }

  const [headers, ...dataRows] = rows;

  return {
    headers,
    rows: dataRows,
    suggestedName: "Imported Deck"
  };
}

function parseJson(content: string): ParsedImport {
  const parsed = JSON.parse(content) as Record<string, unknown>[] | { cards?: Record<string, unknown>[] };

  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed.cards) ? parsed.cards : [];
  if (records.length === 0) {
    throw new Error("JSON import must contain a non-empty array of cards.");
  }

  const headers = Array.from(
    records.reduce<Set<string>>((all, row) => {
      Object.keys(row).forEach((key) => all.add(key));
      return all;
    }, new Set<string>())
  );

  return {
    headers,
    rows: records.map((row) =>
      headers.map((header) => {
        const value = row[header];
        return typeof value === "string" ? value : JSON.stringify(value ?? "");
      })
    ),
    suggestedName: "Imported JSON Deck"
  };
}

function looksLikePlainBlocks(content: string): boolean {
  if (content.includes(",") || content.includes("\t") || content.includes("|")) {
    return false;
  }

  return /\n\s*\n/.test(content);
}

function parsePlainBlocks(content: string): ParsedImport {
  const blocks = content
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 0) {
    throw new Error("No card blocks found in pasted text.");
  }

  const rows = blocks.map((block) => {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const title = lines[0] ?? "";
    const front = lines[1] ?? title;
    const back = lines.slice(2).join("\n");
    return [title, front, back];
  });

  return {
    headers: ["title", "front", "back"],
    rows,
    suggestedName: "Pasted Deck"
  };
}

function normalizeListValue(value: string): string[] {
  return value
    .split(/[;,|]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseImportText(content: string, fileName?: string): ParsedImport {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Import content is empty.");
  }

  const parsed = trimmed.startsWith("[") || trimmed.startsWith("{")
    ? parseJson(trimmed)
    : looksLikePlainBlocks(trimmed)
      ? parsePlainBlocks(trimmed)
      : parseDelimited(trimmed, detectDelimiter(trimmed));

  if (fileName) {
    parsed.suggestedName = fileName.replace(/\.[^.]+$/, "");
  }

  return parsed;
}

export function buildDeckFromImport(
  deckName: string,
  parsedImport: ParsedImport,
  fieldMapping: Record<number, ImportFieldKey>
): Deck {
  const now = new Date().toISOString();
  const cards = parsedImport.rows
    .map((cells, rowIndex) => {
      const mappedRow = Object.entries(fieldMapping).reduce<Record<ImportFieldKey, string>>(
        (result, [columnIndex, key]) => {
          result[key] = cells[Number(columnIndex)]?.trim() ?? "";
          return result;
        },
        {
          title: "",
          front: "",
          back: "",
          category: "",
          tags: "",
          notes: "",
          ignore: ""
        }
      );

      const front = mappedRow.front || mappedRow.title;
      const back = mappedRow.back;
      if (!front || !back) {
        return null;
      }

      const card: Flashcard = {
        id: createId("card"),
        title: mappedRow.title || front.slice(0, 64),
        front,
        back,
        category: mappedRow.category || undefined,
        tags: normalizeListValue(mappedRow.tags),
        notes: mappedRow.notes || undefined,
        sourceRow: rowIndex + 1,
        createdAt: now,
        updatedAt: now
      };

      return card;
    })
    .filter((card): card is NonNullable<typeof card> => card !== null);

  return {
    id: createId("deck"),
    name: deckName || parsedImport.suggestedName,
    description: `Imported ${cards.length} cards`,
    createdAt: now,
    updatedAt: now,
    cards
  };
}

export function suggestFieldMapping(headers: string[]): Record<number, ImportFieldKey> {
  return headers.reduce<Record<number, ImportFieldKey>>((mapping, header, index) => {
    const normalized = header.toLowerCase();

    if (/(title|name|term|concept)/.test(normalized)) {
      mapping[index] = "title";
    } else if (/(front|question|prompt)/.test(normalized)) {
      mapping[index] = "front";
    } else if (/(back|answer|response|definition)/.test(normalized)) {
      mapping[index] = "back";
    } else if (/categor/.test(normalized)) {
      mapping[index] = "category";
    } else if (/tag/.test(normalized)) {
      mapping[index] = "tags";
    } else if (/note|hint|explanation/.test(normalized)) {
      mapping[index] = "notes";
    } else {
      mapping[index] = "ignore";
    }

    return mapping;
  }, {});
}
