(function initLyricsEditorIcons(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LyricsEditorIcons = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createLyricsEditorIcons() {
  "use strict";

  // 歌词编辑器图标集 —— 单一来源
  //
  // 本文件在 shareeditor 与 timelineeditor 两个目录下各有一份，内容必须逐字节相同。
  // tests/design-tokens.test.js 会断言这一点；请勿只改一侧。
  //
  // 全部图标共用 24×24 网格、描边绘制、圆角端点，线宽由 CSS 变量 --icon-stroke 统一控制。
  // 请勿为单个图标覆盖线宽或网格——那正是旧版 Unicode 字形图标观感失衡的根因。
  //
  // 注意：SVG 命名空间字符串只能出现在本文件中。index.html 里不得内联 <svg xmlns>，
  // 因为 embed_test.go 禁止 index.html 出现 "http://"。

  const SVG_NS = "http://www.w3.org/2000/svg";

  // 形状表。每项是 ["路径类型", 属性...]：
  //   p = path(d)   c = circle(cx, cy, r)   r = rect(x, y, w, h, rx)
  // 末尾带 "!" 的类型表示实心填充而非描边。
  const ICONS = Object.freeze({
    // ---- 通用动作 ----
    undo: [["p", "M9 14 4 9l5-5"], ["p", "M4 9h10a5.5 5.5 0 0 1 0 11h-3"]],
    redo: [["p", "m15 14 5-5-5-5"], ["p", "M20 9H10a5.5 5.5 0 0 0 0 11h3"]],
    more: [["c!", 5, 12, 1.6], ["c!", 12, 12, 1.6], ["c!", 19, 12, 1.6]],
    close: [["p", "m6 6 12 12"], ["p", "M18 6 6 18"]],
    check: [["p", "m4 12.5 5.5 5.5L20 7"]],
    plus: [["p", "M12 5v14"], ["p", "M5 12h14"]],
    trash: [["p", "M4 7h16"], ["p", "M9.5 7V4h5v3"], ["p", "m6.5 7 1 13h9l1-13"]],
    search: [["c", 11, 11, 7], ["p", "m20 20-4.3-4.3"]],
    arrowUp: [["p", "M12 20V5"], ["p", "m5.5 11.5 6.5-6.5 6.5 6.5"]],
    chevronLeft: [["p", "m14.5 5-7 7 7 7"]],
    chevronRight: [["p", "m9.5 5 7 7-7 7"]],

    // ---- 工具坞 ----
    lyrics: [["p", "M4 6h16"], ["p", "M4 12h16"], ["p", "M4 18h10"]],
    type: [["p", "M4 6.5V4h16v2.5"], ["p", "M12 4v16"], ["p", "M8.5 20h7"]],
    layout: [["r", 3, 3, 18, 18, 2.5], ["p", "M3 9.5h18"], ["p", "M9.5 21V9.5"]],
    media: [
      ["r", 3, 4, 18, 16, 2.5],
      ["c", 8.5, 9.5, 1.6],
      ["p", "m21 15.5-4.5-4.5L6 21.5"],
    ],
    sticker: [
      ["p", "M12 3.2 14 9h6l-4.9 3.6 1.9 5.8L12 14.8 7 18.4l1.9-5.8L4 9h6z"],
    ],
    template: [["r", 3, 3, 18, 18, 2.5], ["p", "M9 3v18"]],
    palette: [
      ["p", "M12 3.2a8.8 8.8 0 1 0 0 17.6 1.7 1.7 0 0 0 1.25-2.85 1.7 1.7 0 0 1 1.25-2.85h1.6A4.9 4.9 0 0 0 21 10.2c0-3.9-4-7-9-7z"],
      ["c!", 8, 9.5, 1.15],
      ["c!", 12.5, 7.5, 1.15],
      ["c!", 16.5, 10.5, 1.15],
    ],

    // ---- 导出 ----
    download: [["p", "M12 4v11"], ["p", "m7.5 10.5 4.5 4.5 4.5-4.5"], ["p", "M5 19.5h14"]],
    share: [["p", "M12 15V3.5"], ["p", "m8 7.5 4-4 4 4"], ["p", "M5.5 11.5v8a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-8"]],

    // ---- 仓库浏览 ----
    folder: [["p", "M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v8.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"]],
    music: [["p", "M9 18V5.5l11-2V16"], ["c", 6.5, 18, 2.5], ["c", 17.5, 16, 2.5]],

    // ---- 时间轴 ----
    play: [["p!", "M7.5 4.8v14.4L20 12z"]],
    pause: [["r!", 7, 5, 3.4, 14, 1.2], ["r!", 13.6, 5, 3.4, 14, 1.2]],
    save: [
      ["p", "M5 4.8A1.8 1.8 0 0 1 6.8 3h8.4L21 8.8v10.4A1.8 1.8 0 0 1 19.2 21H6.8A1.8 1.8 0 0 1 5 19.2z"],
      ["p", "M8.5 3v6h7"],
      ["p", "M8.5 21v-6h7v6"],
    ],
    clock: [["c", 12, 12, 8.5], ["p", "M12 7v5.3l3.4 2"]],
    insertAbove: [["p", "M4 4h16"], ["p", "M12 20.5V9"], ["p", "m8 13 4-4 4 4"]],
    insertBelow: [["p", "M4 20h16"], ["p", "M12 3.5V15"], ["p", "m8 11 4 4 4-4"]],
  });

  const NAMES = Object.freeze(Object.keys(ICONS));

  function appendShape(svg, shape) {
    const [kind, ...args] = shape;
    const filled = kind.endsWith("!");
    const type = filled ? kind.slice(0, -1) : kind;
    let node;

    if (type === "p") {
      node = svg.ownerDocument.createElementNS(SVG_NS, "path");
      node.setAttribute("d", args[0]);
    } else if (type === "c") {
      node = svg.ownerDocument.createElementNS(SVG_NS, "circle");
      node.setAttribute("cx", args[0]);
      node.setAttribute("cy", args[1]);
      node.setAttribute("r", args[2]);
    } else if (type === "r") {
      node = svg.ownerDocument.createElementNS(SVG_NS, "rect");
      node.setAttribute("x", args[0]);
      node.setAttribute("y", args[1]);
      node.setAttribute("width", args[2]);
      node.setAttribute("height", args[3]);
      node.setAttribute("rx", args[4]);
    } else {
      return;
    }

    if (filled) {
      node.setAttribute("fill", "currentColor");
      node.setAttribute("stroke", "none");
    }
    svg.appendChild(node);
  }

  // 生成一个图标元素。图标是纯装饰，始终 aria-hidden——
  // 无障碍名称必须由承载它的按钮通过 aria-label 提供。
  function create(name, doc) {
    const shapes = ICONS[name];
    if (!shapes) return null;
    const ownerDocument = doc || (typeof document !== "undefined" ? document : null);
    if (!ownerDocument) return null;

    const svg = ownerDocument.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("icon");
    shapes.forEach((shape) => appendShape(svg, shape));
    return svg;
  }

  // 把 [data-icon="name"] 占位元素替换为真实图标。
  // 已经处理过的元素带 data-icon-ready，重复调用是幂等的。
  function hydrate(scope) {
    const container = scope || (typeof document !== "undefined" ? document : null);
    if (!container || typeof container.querySelectorAll !== "function") return 0;
    let count = 0;
    container.querySelectorAll("[data-icon]:not([data-icon-ready])").forEach((slot) => {
      const svg = create(slot.getAttribute("data-icon"), slot.ownerDocument);
      if (!svg) return;
      slot.textContent = "";
      slot.appendChild(svg);
      slot.setAttribute("data-icon-ready", "");
      count += 1;
    });
    return count;
  }

  return Object.freeze({ ICONS, NAMES, SVG_NS, create, hydrate });
});
