// Hand-written Office Open XML spreadsheet (.xlsx): no dependency, no macros, no formulas.
// Each sheet has a frozen, bold header row, column widths, and typed cells: real numbers, Excel
// dates and durations (serial days with a number format), percentages and text. Unknown values
// are empty cells, never 0. A sheet can carry one native line chart (used on "Viewers").
//
// Spec: ECMA-376 Part 1 (SpreadsheetML §18, DrawingML charts §21.2).

import { zip } from './zip.js';

export type ColumnKind = 'text' | 'int' | 'dec' | 'date' | 'duration' | 'pct';

export interface Column {
  header: string;
  /** Characters (Excel's width unit). */
  width?: number;
  kind?: ColumnKind;
}

/**
 * A cell value. Numbers in `date` columns are epoch milliseconds already shifted to the wall clock
 * the reader wants; in `duration` columns seconds; in `pct` columns a fraction (0.5 = 50 %).
 */
export type CellValue = string | number | boolean | null | undefined;

export interface LineChart {
  title: string;
  /** Column index of the categories (x axis). */
  categoryColumn: number;
  /** Column indexes of the series. */
  seriesColumns: number[];
}

export interface Sheet {
  name: string;
  columns: Column[];
  rows: CellValue[][];
  chart?: LineChart;
}

export const MAX_ROWS = 1_048_575; // Excel's limit minus the header
const MAX_TEXT = 32_767;

/** Excel serial day number of an epoch ms value (1900 date system; ignoring the 1900 leap bug, fine after March 1900). */
export function excelSerial(epochMs: number): number {
  return epochMs / 86_400_000 + 25_569;
}

export function colName(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

export function xmlEscape(s: string): string {
  return s
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A valid, unique sheet name (≤ 31 characters, none of []:*?/\). */
export function sheetName(raw: string, taken: Set<string>): string {
  const base = raw.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)} ${i}`;
  taken.add(name.toLowerCase());
  return name;
}

// Styles: index = position in <cellXfs>.
const STYLE: Record<ColumnKind | 'header', number> = { header: 1, text: 0, date: 2, int: 3, dec: 4, duration: 5, pct: 6 };

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/><numFmt numFmtId="165" formatCode="0.0"/><numFmt numFmtId="166" formatCode="[h]:mm:ss"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cellXml(ref: string, value: CellValue, kind: ColumnKind): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    let v = value;
    if (kind === 'date') v = excelSerial(value);
    else if (kind === 'duration') v = value / 86_400;
    const style = kind === 'text' ? 0 : STYLE[kind];
    return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${v}</v></c>`;
  }
  const text = xmlEscape(String(value).slice(0, MAX_TEXT));
  const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}" t="inlineStr"><is><t${space}>${text}</t></is></c>`;
}

function sheetXml(sheet: Sheet, hasDrawing: boolean): string {
  const cols = sheet.columns;
  const rows = sheet.rows.slice(0, MAX_ROWS);
  const lastCol = colName(Math.max(0, cols.length - 1));
  const dim = `A1:${lastCol}${rows.length + 1}`;
  const out: string[] = [];
  out.push(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<dimension ref="${dim}"/>`,
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>',
    '<sheetFormatPr defaultRowHeight="15"/>',
  );
  if (cols.length > 0) {
    out.push('<cols>');
    cols.forEach((c, i) => out.push(`<col min="${i + 1}" max="${i + 1}" width="${c.width ?? Math.max(10, Math.min(60, c.header.length + 2))}" customWidth="1"/>`));
    out.push('</cols>');
  }
  out.push('<sheetData>');
  out.push(`<row r="1">${cols.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="${STYLE.header}"><is><t>${xmlEscape(c.header)}</t></is></c>`).join('')}</row>`);
  rows.forEach((row, ri) => {
    const r = ri + 2;
    let cells = '';
    for (let ci = 0; ci < cols.length; ci++) cells += cellXml(`${colName(ci)}${r}`, row[ci], cols[ci]!.kind ?? 'text');
    out.push(`<row r="${r}">${cells}</row>`);
  });
  out.push('</sheetData>');
  if (hasDrawing) out.push('<drawing r:id="rId1"/>');
  out.push('</worksheet>');
  return out.join('');
}

function quoteSheet(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

/** Series colours (CTD cyan, magenta, then distinct hues); the total, last, is drawn thicker. */
const SERIES_COLORS = ['00A6C8', 'D4009A', 'F2AA3C', '23A15A', '7B3CF0', 'E1306C', '4F6470', '1E6BFF'];

/** Cached values, as Excel writes them: viewers that don't recalculate (previews, LibreOffice export) draw from these. */
function numCache(values: readonly CellValue[], formatCode: string): string {
  const pts = values.map((v, i) => (typeof v === 'number' && Number.isFinite(v) ? `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>` : '')).join('');
  return `<c:numCache><c:formatCode>${xmlEscape(formatCode)}</c:formatCode><c:ptCount val="${values.length}"/>${pts}</c:numCache>`;
}

function chartXml(sheet: Sheet, chart: LineChart): string {
  const rows = sheet.rows.slice(0, MAX_ROWS);
  const n = rows.length;
  const q = quoteSheet(sheet.name);
  const cat = colName(chart.categoryColumn);
  const catKind = sheet.columns[chart.categoryColumn]?.kind;
  const catValues = rows.map((r) => {
    const v = r[chart.categoryColumn];
    return typeof v === 'number' && catKind === 'date' ? excelSerial(v) : v;
  });
  const last = chart.seriesColumns.length - 1;
  const series = chart.seriesColumns
    .map((ci, i) => {
      const c = colName(ci);
      const color = SERIES_COLORS[i % SERIES_COLORS.length];
      const header = xmlEscape(sheet.columns[ci]?.header ?? '');
      return (
        `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>` +
        `<c:tx><c:strRef><c:f>${xmlEscape(`${q}!$${c}$1`)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${header}</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
        `<c:spPr><a:ln w="${i === last ? 31750 : 19050}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr>` +
        `<c:marker><c:symbol val="none"/></c:marker>` +
        `<c:cat><c:numRef><c:f>${xmlEscape(`${q}!$${cat}$2:$${cat}$${n + 1}`)}</c:f>${numCache(catValues, catKind === 'date' ? 'yyyy-mm-dd hh:mm:ss' : 'General')}</c:numRef></c:cat>` +
        `<c:val><c:numRef><c:f>${xmlEscape(`${q}!$${c}$2:$${c}$${n + 1}`)}</c:f>${numCache(rows.map((r) => r[ci]), 'General')}</c:numRef></c:val>` +
        `<c:smooth val="0"/></c:ser>`
      );
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<c:roundedCorners val="0"/><c:chart>' +
    `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${xmlEscape(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>` +
    '<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>' +
    `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/><c:axId val="500100"/><c:axId val="500200"/></c:lineChart>` +
    '<c:catAx><c:axId val="500100"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>' +
    `<c:numFmt formatCode="${catKind === 'date' ? 'hh:mm' : 'General'}" sourceLinked="0"/><c:tickLblPos val="nextTo"/>` +
    // auto=0: a category axis. A date axis counts in whole days, which folds a stream onto one point.
    '<c:crossAx val="500200"/><c:crosses val="autoZero"/><c:auto val="0"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/>' +
    `<c:tickLblSkip val="${Math.max(1, Math.ceil(n / 12))}"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
    '<c:valAx><c:axId val="500200"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/>' +
    '<c:numFmt formatCode="0" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="500100"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>' +
    '</c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>'
  );
}

function drawingXml(firstCol: number): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<xdr:twoCellAnchor>' +
    `<xdr:from><xdr:col>${firstCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>${firstCol + 12}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>24</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>' +
    '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
    '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/>' +
    '</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>'
  );
}

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = (items: { id: string; type: string; target: string }[]): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  items.map((r) => `<Relationship Id="${r.id}" Type="${REL}/${r.type}" Target="${r.target}"/>`).join('') +
  '</Relationships>';

/** Build the .xlsx file. Sheet names are made valid and unique. */
export function buildXlsx(input: readonly Sheet[], opts: { title?: string; created?: Date } = {}): Buffer {
  const taken = new Set<string>();
  const sheets = input.map((s) => ({ ...s, name: sheetName(s.name, taken) }));
  const files: { name: string; data: string }[] = [];
  const overrides: string[] = [];
  let chartN = 0;
  sheets.forEach((s, i) => {
    const n = i + 1;
    const chart = s.chart && s.rows.length >= 2 && s.chart.seriesColumns.length > 0 ? s.chart : undefined;
    files.push({ name: `xl/worksheets/sheet${n}.xml`, data: sheetXml(s, !!chart) });
    overrides.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    if (chart) {
      chartN++;
      files.push({ name: `xl/worksheets/_rels/sheet${n}.xml.rels`, data: rels([{ id: 'rId1', type: 'drawing', target: `../drawings/drawing${chartN}.xml` }]) });
      files.push({ name: `xl/drawings/drawing${chartN}.xml`, data: drawingXml(s.columns.length + 1) });
      files.push({ name: `xl/drawings/_rels/drawing${chartN}.xml.rels`, data: rels([{ id: 'rId1', type: 'chart', target: `../charts/chart${chartN}.xml` }]) });
      files.push({ name: `xl/charts/chart${chartN}.xml`, data: chartXml(s, chart) });
      overrides.push(
        `<Override PartName="/xl/drawings/drawing${chartN}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`,
        `<Override PartName="/xl/charts/chart${chartN}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
      );
    }
  });
  const created = (opts.created ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const head: { name: string; data: string }[] = [
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        overrides.join('') +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>` +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'docProps/core.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        `<dc:title>${xmlEscape(opts.title ?? 'CTD Relay report')}</dc:title><dc:creator>CTD Relay</dc:creator>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
        '</cp:coreProperties>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}">` +
        '<bookViews><workbookView/></bookViews><sheets>' +
        sheets.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: rels([
        ...sheets.map((_, i) => ({ id: `rId${i + 1}`, type: 'worksheet', target: `worksheets/sheet${i + 1}.xml` })),
        { id: `rId${sheets.length + 1}`, type: 'styles', target: 'styles.xml' },
      ]),
    },
    { name: 'xl/styles.xml', data: STYLES_XML },
  ];
  return zip([...head, ...files], opts.created);
}
