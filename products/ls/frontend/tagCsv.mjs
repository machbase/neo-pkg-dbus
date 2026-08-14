function csvError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;

  const finishCell = () => {
    row.push(cell);
    cell = '';
    closedQuote = false;
  };
  const finishRow = () => {
    finishCell();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character !== '"') {
        cell += character;
        continue;
      }
      if (text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = false;
        closedQuote = true;
      }
      continue;
    }
    if (closedQuote && character !== ',' && character !== '\n' && character !== '\r') {
      throw csvError('TAG_CSV_STRUCTURE_INVALID', 'CSV contains characters after a closing quote.');
    }
    if (character === '"') {
      if (cell.length) throw csvError('TAG_CSV_STRUCTURE_INVALID', 'CSV quote must start at the beginning of a cell.');
      quoted = true;
    } else if (character === ',') {
      finishCell();
    } else if (character === '\n') {
      finishRow();
    } else if (character === '\r') {
      if (text[index + 1] === '\n') index += 1;
      finishRow();
    } else {
      cell += character;
    }
  }
  if (quoted) throw csvError('TAG_CSV_STRUCTURE_INVALID', 'CSV contains an unterminated quote.');
  if (cell.length || row.length || closedQuote) finishRow();
  return rows;
}

function csvNumber(value, fallback, row, column) {
  const normalized = value.trim();
  if (!normalized) return fallback;
  const number = Number(normalized);
  if (!Number.isFinite(number)) {
    throw csvError('TAG_CSV_NUMBER_INVALID', `${column} must be a finite number.`, { row, column });
  }
  return number;
}

function csvRowToTag(row, rowNumber) {
  if (row.length !== 4) {
    throw csvError('TAG_CSV_STRUCTURE_INVALID', 'Each applicable CSV row must have four columns.', { row: rowNumber });
  }
  const name = row[0].trim();
  if (!name) throw csvError('TAG_CSV_NAME_REQUIRED', 'Tag name is required.', { row: rowNumber, column: 'name' });
  const bias = csvNumber(row[1], 0, rowNumber, 'bias');
  const multiplier = csvNumber(row[2], 1, rowNumber, 'multiplier');
  const order = row[3].trim() || '0';
  if (order !== '0' && order !== '1') {
    throw csvError('TAG_CSV_ORDER_INVALID', 'order must be 0 or 1.', { row: rowNumber, column: 'order' });
  }
  return {
    name,
    bias,
    multiplier,
    transformOrder: order === '0' ? ['bias', 'multiplier'] : ['multiplier', 'bias'],
  };
}

export function applyLsTagCsv(text, currentTags, dataCount) {
  const tags = Array.isArray(currentTags) ? currentTags : [];
  const limit = Math.min(Math.max(0, Number(dataCount) || 0), tags.length);
  const rows = parseCsvRows(String(text ?? ''));
  const header = rows.shift() || [];
  if (header.length !== 4
    || header[0]?.replace(/^\uFEFF/, '') !== 'name'
    || header[1] !== 'bias'
    || header[2] !== 'multiplier'
    || header[3] !== 'order') {
    throw csvError('TAG_CSV_HEADER_INVALID', 'CSV header must be name,bias,multiplier,order.', { row: 1 });
  }
  const sourceRows = rows.filter((sourceRow) => sourceRow.some((value) => value.trim() !== ''));
  if (!sourceRows.length || limit === 0) {
    throw csvError('TAG_CSV_EMPTY', 'CSV has no applicable Tag rows.');
  }
  const replacements = sourceRows.slice(0, limit).map((sourceRow, index) => csvRowToTag(sourceRow, index + 2));
  return tags.map((tag, index) => index < replacements.length
    ? { ...tag, ...replacements[index], nameMode: 'manual' }
    : tag);
}
