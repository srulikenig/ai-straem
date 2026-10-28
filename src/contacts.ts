import readXlsxFile from 'read-excel-file/node';

export interface ContactInput {
  name: string;
  phone: string;
  notes: string;
}

/**
 * Israeli numbers in the one shape the PBX sends: digits only, leading 0.
 * "+972-52-123 4567", "972521234567" and "52-1234567" all become 0521234567.
 * Returns null for anything that is not a plausible phone number.
 */
export function normalizePhone(raw: unknown): string | null {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('972')) d = d.slice(3);
  if (d && !d.startsWith('0')) d = `0${d}`;
  return /^0\d{8,9}$/.test(d) ? d : null;
}

const NAME_HEADERS = ['שם', 'name', 'שם מלא', 'איש קשר', 'contact'];
const PHONE_HEADERS = ['טלפון', 'phone', 'נייד', 'מספר', 'mobile', 'tel', 'פלאפון'];
const NOTES_HEADERS = ['הערות', 'הערה', 'notes', 'note'];

const headerIndex = (header: string[], names: string[]) =>
  header.findIndex((h) => names.some((n) => h.includes(n)));

/**
 * Turns spreadsheet rows into contacts. A header row is recognised by its
 * Hebrew or English titles; without one, column A is the name and column B
 * the phone. Rows without a usable phone are reported, not guessed at.
 */
export function rowsToContacts(rows: unknown[][]): { contacts: ContactInput[]; skipped: number } {
  const cells = rows.map((r) => r.map((c) => String(c ?? '').trim())).filter((r) => r.some(Boolean));
  if (cells.length === 0) return { contacts: [], skipped: 0 };

  const header = cells[0]!.map((h) => h.toLowerCase());
  let nameCol = headerIndex(header, NAME_HEADERS);
  let phoneCol = headerIndex(header, PHONE_HEADERS);
  const notesCol = headerIndex(header, NOTES_HEADERS);
  const hasHeader = phoneCol >= 0;
  if (!hasHeader) {
    nameCol = 0;
    phoneCol = 1;
  }

  const contacts: ContactInput[] = [];
  let skipped = 0;
  for (const r of hasHeader ? cells.slice(1) : cells) {
    const phone = normalizePhone(r[phoneCol]);
    if (!phone) {
      skipped++;
      continue;
    }
    contacts.push({ name: (nameCol >= 0 ? r[nameCol] : '') || phone, phone, notes: notesCol >= 0 ? (r[notesCol] ?? '') : '' });
  }
  return { contacts, skipped };
}

/** Minimal CSV: commas or semicolons, double-quoted fields, "" as an escaped quote. */
export function parseCsv(text: string): string[][] {
  const delimiter = (text.split('\n')[0] ?? '').includes(';') && !(text.split('\n')[0] ?? '').includes(',') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Excel (.xlsx) or CSV, told apart by the zip signature rather than the file name. */
export async function readContactsFile(data: Buffer): Promise<{ contacts: ContactInput[]; skipped: number }> {
  const isZip = data.length > 4 && data[0] === 0x50 && data[1] === 0x4b;
  if (isZip) {
    const sheets = await readXlsxFile(data);
    return rowsToContacts(sheets[0]?.data ?? []);
  }
  return rowsToContacts(parseCsv(data.toString('utf8').replace(/^﻿/, '')));
}
