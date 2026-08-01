/**
 * Генерация .pptx (PowerPoint) без внешних зависимостей — работает в Cloudflare Workers.
 * Кириллица нативная (UTF-8 в OOXML). Файл легко открывается в PowerPoint / Google Slides /
 * Keynote и экспортируется в PDF в один клик. Архив собирается методом STORE (переиспользуем zip из docx).
 */
import { zip } from "./docx";

const enc = new TextEncoder();
// Размер слайда 16:9 в EMU (914400 EMU = 1 дюйм): 13.333" × 7.5"
const W = 12192000;
const H = 6858000;

function esc(s: string): string {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c] as string));
}

export interface Slide {
  title: string;
  bullets?: string[];
  subtitle?: string; // для титульного слайда
}

/** Текстовый блок (title placeholder). */
function titleShape(text: string, cover: boolean): string {
  const y = cover ? 2600000 : 350000;
  const cx = W - 1400000;
  const sz = cover ? 4000 : 2800;
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="700000" y="${y}"/><a:ext cx="${cx}" cy="1200000"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>` +
    `<a:p><a:pPr algn="${cover ? "ctr" : "l"}"/><a:r><a:rPr lang="ru-RU" sz="${sz}" b="1"/><a:t>${esc(text)}</a:t></a:r></a:p>` +
    `</p:txBody></p:sp>`
  );
}

/** Блок с маркированным списком (body placeholder). */
function bodyShape(bullets: string[]): string {
  const paras = bullets
    .map((b) => {
      const t = (b || "").replace(/^[-•*]\s*/, "");
      return `<a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="ru-RU" sz="2000"/><a:t>${esc(t)}</a:t></a:r></a:p>`;
    })
    .join("");
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="700000" y="1700000"/><a:ext cx="${W - 1400000}" cy="${H - 2100000}"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${paras || `<a:p><a:endParaRPr lang="ru-RU"/></a:p>`}</p:txBody></p:sp>`
  );
}

/** Подзаголовок на титульном слайде. */
function subtitleShape(text: string): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Subtitle"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="700000" y="3900000"/><a:ext cx="${W - 1400000}" cy="900000"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>` +
    `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="ru-RU" sz="2000"/><a:t>${esc(text)}</a:t></a:r></a:p>` +
    `</p:txBody></p:sp>`
  );
}

function slideXml(s: Slide, cover: boolean): string {
  const shapes = cover
    ? titleShape(s.title, true) + (s.subtitle ? subtitleShape(s.subtitle) : "")
    : titleShape(s.title, false) + bodyShape(s.bullets || []);
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping ` +
    `bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ` +
    `accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sld>`
  );
}

const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function theme(): string {
  const scheme =
    `<a:clrScheme name="Sara"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
    `<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
    `<a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2>` +
    `<a:accent1><a:srgbClr val="6C5CE7"/></a:accent1><a:accent2><a:srgbClr val="00B894"/></a:accent2>` +
    `<a:accent3><a:srgbClr val="0984E3"/></a:accent3><a:accent4><a:srgbClr val="FDCB6E"/></a:accent4>` +
    `<a:accent5><a:srgbClr val="E17055"/></a:accent5><a:accent6><a:srgbClr val="D63031"/></a:accent6>` +
    `<a:hlink><a:srgbClr val="0984E3"/></a:hlink><a:folHlink><a:srgbClr val="6C5CE7"/></a:folHlink></a:clrScheme>`;
  const font =
    `<a:fontScheme name="Sara"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>`;
  const fmt =
    `<a:fmtScheme name="Sara">` +
    `<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
    `<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>` +
    `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
    `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>` +
    `</a:fmtScheme>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<a:theme xmlns:a="${"http://schemas.openxmlformats.org/drawingml/2006/main"}" name="Sara">` +
    `<a:themeElements>${scheme}${font}${fmt}</a:themeElements>` +
    `<a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`
  );
}

function slideLayout(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="${NS_R}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ` +
    `type="obj" preserve="1"><p:cSld name="Blank"><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping ` +
    `bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ` +
    `accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sldLayout>`
  );
}

function slideMaster(): string {
  const txStyles =
    `<p:txStyles>` +
    `<p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="2800" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr></a:lvl1pPr></p:titleStyle>` +
    `<p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="•"/><a:defRPr sz="2000"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr></a:lvl1pPr>` +
    `<a:lvl2pPr marL="742950" indent="-285750"><a:buChar char="–"/><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl2pPr></p:bodyStyle>` +
    `<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="${NS_R}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
    `<p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="700000" y="350000"/><a:ext cx="${W - 1400000}" cy="1200000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ru-RU"/><a:t>Заголовок</a:t></a:r></a:p></p:txBody></p:sp>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="700000" y="1700000"/><a:ext cx="${W - 1400000}" cy="${H - 2100000}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ru-RU"/><a:t>Текст</a:t></a:r></a:p></p:txBody></p:sp>` +
    `</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ` +
    `accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
    `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>${txStyles}</p:sldMaster>`
  );
}

/** Собирает .pptx из массива слайдов. Первый слайд — титульный. Возвращает байты файла. */
export function buildPptx(slides: Slide[]): Uint8Array {
  if (!slides.length) slides = [{ title: "Презентация" }];
  const n = slides.length;

  const slideParts = slides.map((s, i) => ({
    name: `ppt/slides/slide${i + 1}.xml`,
    data: enc.encode(slideXml(s, i === 0)),
  }));
  const slideRels = slides.map((_, i) => ({
    name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
    data: enc.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${NS_R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`
    ),
  }));

  const sldIdLst = slides
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
    .join("");
  const presentation =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="${NS_R}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId${n + 1}"/></p:sldMasterIdLst>` +
    `<p:sldIdLst>${sldIdLst}</p:sldIdLst>` +
    `<p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="${H}" cy="${W}"/></p:presentation>`;

  // связи презентации: слайды → rId1..N, мастер → rId(N+1)
  const presRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_R}/slide" Target="slides/slide${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${n + 1}" Type="${NS_R}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
    `</Relationships>`;

  const masterRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${NS_R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
    `<Relationship Id="rId2" Type="${NS_R}/theme" Target="../theme/theme1.xml"/></Relationships>`;

  const layoutRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${NS_R}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;

  const slideOverrides = slides
    .map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    .join("");
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
    slideOverrides +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;

  return zip([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "ppt/presentation.xml", data: enc.encode(presentation) },
    { name: "ppt/_rels/presentation.xml.rels", data: enc.encode(presRels) },
    { name: "ppt/slideMasters/slideMaster1.xml", data: enc.encode(slideMaster()) },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: enc.encode(masterRels) },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: enc.encode(slideLayout()) },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: enc.encode(layoutRels) },
    { name: "ppt/theme/theme1.xml", data: enc.encode(theme()) },
    ...slideParts,
    ...slideRels,
  ]);
}
