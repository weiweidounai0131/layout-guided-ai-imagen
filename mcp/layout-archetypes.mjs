const SCHEMA_VERSION = "layout-archetypes/1";
const VIEW_BOX = "0 0 120 160";
const CATALOG_PROVENANCE = {
  kind: "product-owned",
  owner: "layout-guided-ai-imagen",
  source: "internal-layout-archetype-catalog",
  inspiration: {
    publisher: "OpenAI",
    url: "https://openai.com/index/introducing-chatgpt-images-2-5/",
    scope: "公开文章中的 Sketch 视觉参考与 flyers/product photos 格式模板示例",
    exhaustive_catalog: false
  },
  boundary: "本目录为产品自研分类，不是 OpenAI 官方完整版式列表。"
};

// The catalog is inspectable by a host workflow, but this release has no
// evidence of a host model making aesthetic choices. Keep the method explicit
// so a score/rationale cannot be mistaken for an ordinary-model recommendation.
const SELECTION_POLICY = {
  method: "deterministic_scoring",
  execution: "local_fallback",
  model_call: false,
  aesthetic_evidence: "unverified",
  host_role: "inspect_and_explain"
};

function rect(x, y, width, height, options = {}) {
  return { type: "rect", x, y, width, height, ...options };
}

function circle(cx, cy, radius, options = {}) {
  return { type: "circle", cx, cy, radius, ...options };
}

function line(x1, y1, x2, y2, options = {}) {
  return { type: "line", x1, y1, x2, y2, ...options };
}

const SCHEMATIC_COLORS = {
  ink: "#263247",
  muted: "#9aa8bb",
  accent: "#5f86c9",
  soft: "#dce7f6",
  quiet: "#edf2f8",
  frame: "#7f93ad"
};

const RAW_LAYOUT_ARCHETYPES = [
  {
    id: "center-hero",
    name: "中心英雄",
    description: "标题建立入口，主视觉居中占据主要份额，辅助信息沿上下阅读。",
    fit_signals: [
      { signal: "hero_focus", weight: 10, reason: "主视觉定义清晰，适合集中表现主体" },
      { signal: "short_copy", weight: 4, reason: "文案较短，不会挤压中心主体" },
      { signal: "product_or_person", weight: 3, reason: "人物或产品适合成为单一视觉锚点" }
    ],
    avoid_conditions: [
      { signal: "copy_dense", penalty: 8, reason: "信息密集时中心主体会压缩文字层级" },
      { signal: "modular_content", penalty: 4, reason: "多模块信息更适合网格或分层结构" }
    ],
    composition_grammar: "title → centered hero → supporting copy → footer",
    slots: ["title", "subtitle", "hero", "supporting_copy", "footer"],
    difference_axes: ["hero_position", "hero_share", "top_to_bottom_reading"],
    geometry: {
      hero: { x: 0.1, y: 0.34, width: 0.8, height: 0.43 },
      title: { x: 0.08, y: 0.07, width: 0.84, align: "center" },
      copy_mode: "center_stack",
      asset_mode: "balanced"
    },
    schematic: {
      viewBox: VIEW_BOX,
      elements: [
        rect(22, 10, 76, 5, { fill: SCHEMATIC_COLORS.ink, rx: 2 }),
        rect(34, 19, 52, 3, { fill: SCHEMATIC_COLORS.muted, rx: 1.5 }),
        circle(60, 79, 39, { fill: SCHEMATIC_COLORS.soft, stroke: SCHEMATIC_COLORS.accent, strokeWidth: 2 }),
        rect(29, 132, 62, 4, { fill: SCHEMATIC_COLORS.muted, rx: 2 }),
        rect(38, 143, 44, 5, { fill: SCHEMATIC_COLORS.accent, rx: 2 })
      ]
    }
  },
  {
    id: "bold-type",
    name: "大字主导",
    description: "用高占比标题形成传播记忆，主视觉退到侧边作为明确锚点。",
    fit_signals: [
      { signal: "title_short", weight: 7, reason: "短标题适合放大成为首要层级" },
      { signal: "formal_or_campaign", weight: 4, reason: "活动或传播目的需要快速建立主题" },
      { signal: "action_or_announcement", weight: 3, reason: "行动或发布信息适合强入口" }
    ],
    avoid_conditions: [
      { signal: "title_long", penalty: 7, reason: "标题过长会削弱大字识别度" },
      { signal: "copy_dense", penalty: 4, reason: "大量说明不适合集中在大字层级" }
    ],
    composition_grammar: "oversized title → offset hero → compact supporting copy",
    slots: ["title", "hero", "subtitle", "supporting_copy", "footer"],
    difference_axes: ["typography_dominance", "hero_share", "reading_path"],
    geometry: {
      hero: { x: 0.57, y: 0.35, width: 0.35, height: 0.39 },
      title: { x: 0.08, y: 0.11, width: 0.48, align: "left", scale: 1.18 },
      copy_mode: "left_stack",
      asset_mode: "stack"
    },
    schematic: {
      viewBox: VIEW_BOX,
      elements: [
        rect(10, 18, 49, 11, { fill: SCHEMATIC_COLORS.ink, rx: 2 }),
        rect(10, 34, 43, 7, { fill: SCHEMATIC_COLORS.ink, rx: 2 }),
        rect(10, 46, 31, 3, { fill: SCHEMATIC_COLORS.muted, rx: 1.5 }),
        circle(87, 73, 23, { fill: SCHEMATIC_COLORS.soft, stroke: SCHEMATIC_COLORS.accent, strokeWidth: 2 }),
        rect(11, 120, 42, 4, { fill: SCHEMATIC_COLORS.muted, rx: 2 }),
        rect(11, 130, 36, 4, { fill: SCHEMATIC_COLORS.accent, rx: 2 }),
        line(63, 106, 104, 106, { stroke: SCHEMATIC_COLORS.quiet, strokeWidth: 4 })
      ]
    }
  },
  {
    id: "split-columns",
    name: "图文分割",
    description: "左侧承担信息阅读，右侧稳定承载主视觉，适合并置两种内容。",
    fit_signals: [
      { signal: "copy_multiple", weight: 6, reason: "多个文案块需要独立的信息列" },
      { signal: "product_or_person", weight: 4, reason: "主体可以与说明形成并置关系" },
      { signal: "comparison_or_parallel", weight: 5, reason: "并列关系适合左右分区" }
    ],
    avoid_conditions: [
      { signal: "hero_focus_only", penalty: 5, reason: "单一沉浸主体不需要分栏" },
      { signal: "copy_dense", penalty: 3, reason: "过长信息会让两列都变窄" }
    ],
    composition_grammar: "left information rail || right hero rail → bottom action",
    slots: ["title", "subtitle", "supporting_copy", "hero", "footer"],
    difference_axes: ["split_columns", "copy_to_hero_ratio", "reading_path"],
    geometry: {
      hero: { x: 0.5, y: 0.25, width: 0.42, height: 0.55 },
      title: { x: 0.08, y: 0.08, width: 0.37, align: "left" },
      copy_mode: "left_stack",
      asset_mode: "stack"
    },
    schematic: {
      viewBox: VIEW_BOX,
      elements: [
        rect(10, 11, 42, 5, { fill: SCHEMATIC_COLORS.ink, rx: 2 }),
        rect(10, 21, 33, 3, { fill: SCHEMATIC_COLORS.muted, rx: 1.5 }),
        rect(10, 38, 31, 4, { fill: SCHEMATIC_COLORS.quiet, rx: 2 }),
        rect(10, 48, 36, 4, { fill: SCHEMATIC_COLORS.quiet, rx: 2 }),
        rect(10, 58, 27, 4, { fill: SCHEMATIC_COLORS.quiet, rx: 2 }),
        rect(65, 25, 42, 73, { fill: SCHEMATIC_COLORS.soft, stroke: SCHEMATIC_COLORS.accent, strokeWidth: 2, rx: 4 }),
        rect(20, 127, 80, 5, { fill: SCHEMATIC_COLORS.accent, rx: 2 }),
        line(58, 8, 58, 116, { stroke: SCHEMATIC_COLORS.frame, strokeWidth: 1 })
      ]
    }
  },
  {
    id: "top-bottom",
    name: "上下分区",
    description: "上部先交代主题，下部展开主视觉与行动信息，阅读顺序直接。",
    fit_signals: [
      { signal: "formal_or_campaign", weight: 5, reason: "正式活动信息适合先标题后内容" },
      { signal: "copy_multiple", weight: 4, reason: "上下分区能容纳多组短文案" },
      { signal: "scenic_visual", weight: 3, reason: "场景主体适合在下部完整展开" }
    ],
    avoid_conditions: [
      { signal: "dynamic", penalty: 4, reason: "强动势题材可能需要斜向阅读" },
      { signal: "short_copy", penalty: 2, reason: "内容过少时上下分区显得松散" }
    ],
    composition_grammar: "top title band → middle hero → bottom information band",
    slots: ["title", "subtitle", "hero", "supporting_copy", "footer"],
    difference_axes: ["vertical_zones", "hero_timing", "reading_path"],
    geometry: {
      hero: { x: 0.1, y: 0.3, width: 0.8, height: 0.42 },
      title: { x: 0.08, y: 0.06, width: 0.84, align: "center" },
      copy_mode: "bottom_stack",
      asset_mode: "balanced"
    },
    schematic: {
      viewBox: VIEW_BOX,
      elements: [
        rect(12, 9, 96, 24, { fill: SCHEMATIC_COLORS.quiet, stroke: SCHEMATIC_COLORS.frame, strokeWidth: 1, rx: 3 }),
        rect(28, 15, 64, 5, { fill: SCHEMATIC_COLORS.ink, rx: 2 }),
        rect(38, 24, 44, 3, { fill: SCHEMATIC_COLORS.muted, rx: 1.5 }),
        rect(16, 43, 88, 56, { fill: SCHEMATIC_COLORS.soft, stroke: SCHEMATIC_COLORS.accent, strokeWidth: 2, rx: 4 }),
        rect(22, 111, 76, 4, { fill: SCHEMATIC_COLORS.muted, rx: 2 }),
        rect(24, 122, 72, 15, { fill: SCHEMATIC_COLORS.quiet, stroke: SCHEMATIC_COLORS.frame, strokeWidth: 1, rx: 3 }),
        rect(39, 127, 42, 4, { fill: SCHEMATIC_COLORS.accent, rx: 2 })
      ]
    }
  },
  {
    id: "title-led",
    name: "标题突出",
    description: "标题作为独立的高识别入口，主视觉与信息块围绕标题组织。",
    fit_signals: [
      { signal: "title_short", weight: 5, reason: "标题适合形成独立的显著区块" },
      { signal: "action_or_announcement", weight: 4, reason: "发布和行动场景需要醒目入口" },
      { signal: "hero_focus", weight: 2, reason: "主视觉可作为标题后的证据" }
    ],
    avoid_conditions: [
      { signal: "title_long", penalty: 5, reason: "长标题不适合独立突出" },
      { signal: "copy_dense", penalty: 3, reason: "高密度信息会削弱标题区的留白" }
    ],
    composition_grammar: "title card → supporting detail + hero → action footer",
    slots: ["title", "subtitle", "hero", "supporting_copy", "footer"],
    difference_axes: ["title_dominance", "title_isolation", "hierarchy"],
    geometry: {
      hero: { x: 0.16, y: 0.4, width: 0.68, height: 0.31 },
      title: { x: 0.08, y: 0.06, width: 0.84, align: "center", scale: 1.12 },
      copy_mode: "top_stack",
      asset_mode: "balanced"
    },
    schematic: {
      viewBox: VIEW_BOX,
      elements: [
        rect(9, 9, 102, 31, { fill: SCHEMATIC_COLORS.ink, rx: 4 }),
        rect(23, 20, 74, 8, { fill: "#ffffff", rx: 3 }),
        rect(19, 51, 82, 4, { fill: SCHEMATIC_COLORS.muted, rx: 2 }),
        rect(17, 65, 86, 44, { fill: SCHEMATIC_COLORS.soft, stroke: SCHEMATIC_COLORS.accent, strokeWidth: 2, rx: 4 }),
        rect(30, 120, 60, 4, { fill: SCHEMATIC_COLORS.quiet, rx: 2 }),
        rect(35, 133, 50, 5, { fill: SCHEMATIC_COLORS.accent, rx: 2 })
      ]
    }
  },
  {
    id: "module-grid",
    name: "网格模块",
    description: "把多个信息和素材拆成可扫描模块，适合服务、清单、参数与多要点。",
    fit_signals: [
      { signal: "modular_content", weight: 10, reason: "多个要点天然适合模块化扫描" },
      { signal: "copy_multiple", weight: 5, reason: "多组短文案可以独立落位" },
      { signal: "product_or_person", weight: 2, reason: "素材可成为网格中的核心模块" }
    ],
    avoid_conditions: [
      { signal: "hero_focus_only", penalty: 6, reason: "单一主体会被网格切碎" },
      { signal: "short_copy", penalty: 3, reason: "内容过少时网格失去信息价值" }
    ],
    composition_grammar: "title row → modular grid of hero/supporting slots → footer",
    slots: ["title", "subtitle", "hero", "supporting_copy", "footer"],
    difference_axes: ["modularity", "information_density", "scan_path"],
    geometry: {
      hero: { x: 0.08, y: 0.38, width: 0.5, height: 0.37 },
      title: { x: 0.08, y: 0.07, width: 0.84, align: "left" },
      copy_mode: "dense_grid",
      asset_mode: "grid"
    },
    schematic: {
      viewBox: VIEW_BOX,
      elements: [
        rect(10, 10, 67, 5, { fill: SCHEMATIC_COLORS.ink, rx: 2 }),
        rect(10, 21, 42, 3, { fill: SCHEMATIC_COLORS.muted, rx: 1.5 }),
        rect(10, 39, 47, 37, { fill: SCHEMATIC_COLORS.soft, stroke: SCHEMATIC_COLORS.accent, strokeWidth: 2, rx: 3 }),
        rect(63, 39, 21, 17, { fill: SCHEMATIC_COLORS.quiet, stroke: SCHEMATIC_COLORS.frame, strokeWidth: 1, rx: 2 }),
        rect(88, 39, 21, 17, { fill: SCHEMATIC_COLORS.quiet, stroke: SCHEMATIC_COLORS.frame, strokeWidth: 1, rx: 2 }),
        rect(63, 62, 21, 17, { fill: SCHEMATIC_COLORS.quiet, stroke: SCHEMATIC_COLORS.frame, strokeWidth: 1, rx: 2 }),
        rect(88, 62, 21, 17, { fill: SCHEMATIC_COLORS.quiet, stroke: SCHEMATIC_COLORS.frame, strokeWidth: 1, rx: 2 }),
        rect(19, 93, 90, 4, { fill: SCHEMATIC_COLORS.muted, rx: 2 }),
        rect(27, 111, 82, 5, { fill: SCHEMATIC_COLORS.accent, rx: 2 })
      ]
    }
  },
  {
    id: "framed-scene",
    name: "框景构图",
    description: "用边界框住场景或主体，外围留出说明和呼吸空间。",
    fit_signals: [
      { signal: "scenic_visual", weight: 8, reason: "场景主体适合在框内保持完整关系" },
      { signal: "visual_story", weight: 5, reason: "故事性画面需要稳定的观看窗口" },
      { signal: "hero_focus", weight: 3, reason: "主体仍是框景内的视觉锚点" }
    ],
    avoid_conditions: [
      { signal: "copy_dense", penalty: 6, reason: "外围信息过多会侵占框景呼吸空间" },
      { signal: "modular_content", penalty: 3, reason: "模块列表更适合网格" }
    ],
    composition_grammar: "title outside frame → framed hero scene → caption/footer outside frame",
    slots: ["title", "hero", "subtitle", "supporting_copy", "footer"],
    difference_axes: ["framing", "scene_integrity", "whitespace"],
    geometry: {
      hero: { x: 0.14, y: 0.29, width: 0.72, height: 0.48 },
      title: { x: 0.1, y: 0.07, width: 0.8, align: "left" },
      copy_mode: "bottom_stack",
      asset_mode: "balanced",
      framed: true
    },
    schematic: {
      viewBox: VIEW_BOX,
      elements: [
        rect(11, 10, 63, 5, { fill: SCHEMATIC_COLORS.ink, rx: 2 }),
        rect(11, 20, 44, 3, { fill: SCHEMATIC_COLORS.muted, rx: 1.5 }),
        rect(14, 38, 92, 72, { fill: "none", stroke: SCHEMATIC_COLORS.frame, strokeWidth: 3, rx: 5 }),
        rect(22, 46, 76, 56, { fill: SCHEMATIC_COLORS.soft, stroke: SCHEMATIC_COLORS.accent, strokeWidth: 2, rx: 3 }),
        rect(27, 121, 66, 4, { fill: SCHEMATIC_COLORS.muted, rx: 2 }),
        rect(35, 133, 50, 5, { fill: SCHEMATIC_COLORS.accent, rx: 2 })
      ]
    }
  },
  {
    id: "diagonal-flow",
    name: "对角动线",
    description: "从左上到右下建立方向，适合带有动作、速度或明确行动出口的主题。",
    fit_signals: [
      { signal: "dynamic", weight: 10, reason: "运动或行动信号适合斜向阅读" },
      { signal: "action_or_announcement", weight: 4, reason: "行动入口可以落在动线终点" },
      { signal: "hero_focus", weight: 3, reason: "主体可沿对角线形成视觉推进" }
    ],
    avoid_conditions: [
      { signal: "copy_dense", penalty: 7, reason: "长说明会打断斜向动线" },
      { signal: "formal_quiet", penalty: 3, reason: "安静正式主题不一定需要强动势" }
    ],
    composition_grammar: "top-left title ↘ hero anchor ↘ bottom-right action",
    slots: ["title", "subtitle", "hero", "supporting_copy", "footer"],
    difference_axes: ["diagonal_axis", "dynamic_rhythm", "action_position"],
    geometry: {
      hero: { x: 0.27, y: 0.3, width: 0.57, height: 0.42 },
      title: { x: 0.08, y: 0.07, width: 0.53, align: "left" },
      copy_mode: "right_stack",
      asset_mode: "balanced",
      diagonal: true
    },
    schematic: {
      viewBox: VIEW_BOX,
      elements: [
        rect(10, 10, 48, 5, { fill: SCHEMATIC_COLORS.ink, rx: 2 }),
        rect(10, 21, 32, 3, { fill: SCHEMATIC_COLORS.muted, rx: 1.5 }),
        line(16, 40, 103, 118, { stroke: SCHEMATIC_COLORS.frame, strokeWidth: 2 }),
        rect(34, 48, 62, 50, { fill: SCHEMATIC_COLORS.soft, stroke: SCHEMATIC_COLORS.accent, strokeWidth: 2, rx: 4, transform: "rotate(8 65 73)" }),
        rect(74, 112, 35, 5, { fill: SCHEMATIC_COLORS.accent, rx: 2 }),
        rect(69, 126, 40, 4, { fill: SCHEMATIC_COLORS.muted, rx: 2 })
      ]
    }
  },
  {
    id: "full-bleed",
    name: "全幅沉浸",
    description: "主视觉几乎铺满画布，文案作为轻量叠加层保持画面完整。",
    fit_signals: [
      { signal: "hero_focus_only", weight: 10, reason: "视觉主体是唯一主要内容" },
      { signal: "scenic_visual", weight: 6, reason: "场景需要完整铺陈氛围" },
      { signal: "short_copy", weight: 4, reason: "少量文案适合叠加而不遮挡主体" }
    ],
    avoid_conditions: [
      { signal: "copy_dense", penalty: 10, reason: "高密度信息不适合叠加在沉浸画面上" },
      { signal: "modular_content", penalty: 6, reason: "模块信息需要独立结构" }
    ],
    composition_grammar: "full-bleed hero → overlaid title → minimal action/footer",
    slots: ["hero", "title", "subtitle", "footer"],
    difference_axes: ["hero_share", "overlay_hierarchy", "immersion"],
    geometry: {
      hero: { x: 0.02, y: 0.02, width: 0.96, height: 0.88 },
      title: { x: 0.08, y: 0.1, width: 0.84, align: "center" },
      copy_mode: "overlay",
      asset_mode: "grid",
      full_bleed: true
    },
    schematic: {
      viewBox: VIEW_BOX,
      elements: [
        rect(5, 5, 110, 139, { fill: SCHEMATIC_COLORS.soft, stroke: SCHEMATIC_COLORS.accent, strokeWidth: 2, rx: 5 }),
        circle(76, 80, 35, { fill: "#ffffff", stroke: SCHEMATIC_COLORS.frame, strokeWidth: 2 }),
        rect(16, 18, 88, 7, { fill: "#ffffff", rx: 3 }),
        rect(29, 31, 62, 4, { fill: "#ffffff", rx: 2 }),
        rect(28, 124, 64, 5, { fill: "#ffffff", rx: 2 })
      ]
    }
  },
  {
    id: "minimal-space",
    name: "留白极简",
    description: "用少量元素和宽松留白维持平静、精确的阅读节奏。",
    fit_signals: [
      { signal: "short_copy", weight: 8, reason: "文案较少能保留足够留白" },
      { signal: "premium_or_calm", weight: 8, reason: "高级或克制风格需要简洁层级" },
      { signal: "hero_focus", weight: 3, reason: "少量主体可被精确强调" }
    ],
    avoid_conditions: [
      { signal: "copy_dense", penalty: 10, reason: "信息过多会破坏留白节奏" },
      { signal: "modular_content", penalty: 7, reason: "多模块内容不适合极简结构" }
    ],
    composition_grammar: "small title → generous whitespace → precise hero → quiet footer",
    slots: ["title", "hero", "subtitle", "footer"],
    difference_axes: ["whitespace", "density", "quiet_hierarchy"],
    geometry: {
      hero: { x: 0.25, y: 0.42, width: 0.5, height: 0.27 },
      title: { x: 0.16, y: 0.12, width: 0.68, align: "center" },
      copy_mode: "minimal",
      asset_mode: "stack"
    },
    schematic: {
      viewBox: VIEW_BOX,
      elements: [
        rect(28, 19, 64, 4, { fill: SCHEMATIC_COLORS.ink, rx: 2 }),
        rect(42, 30, 36, 2, { fill: SCHEMATIC_COLORS.muted, rx: 1 }),
        circle(60, 78, 22, { fill: SCHEMATIC_COLORS.soft, stroke: SCHEMATIC_COLORS.accent, strokeWidth: 2 }),
        rect(40, 121, 40, 2, { fill: SCHEMATIC_COLORS.muted, rx: 1 }),
        line(26, 137, 94, 137, { stroke: SCHEMATIC_COLORS.quiet, strokeWidth: 2 })
      ]
    }
  },
  {
    id: "information-stack",
    name: "信息密集分层",
    description: "优先容纳完整说明与层层信息，主视觉退居为结构中的一个层级。",
    fit_signals: [
      { signal: "copy_dense", weight: 11, reason: "长文案和字段需要更多可读区域" },
      { signal: "formal_or_campaign", weight: 3, reason: "通知、课程或规则类内容需要清晰分层" },
      { signal: "copy_multiple", weight: 4, reason: "多段文字可以按层级展开" }
    ],
    avoid_conditions: [
      { signal: "hero_focus_only", penalty: 8, reason: "单一主体会被密集信息削弱" },
      { signal: "short_copy", penalty: 4, reason: "内容过少时分层没有必要" }
    ],
    composition_grammar: "title → stacked information bands → supporting hero → footer",
    slots: ["title", "subtitle", "supporting_copy", "hero", "footer"],
    difference_axes: ["information_density", "copy_hierarchy", "hero_share"],
    geometry: {
      hero: { x: 0.58, y: 0.57, width: 0.32, height: 0.22 },
      title: { x: 0.08, y: 0.06, width: 0.84, align: "left" },
      copy_mode: "dense_stack",
      asset_mode: "stack"
    },
    schematic: {
      viewBox: VIEW_BOX,
      elements: [
        rect(10, 9, 74, 5, { fill: SCHEMATIC_COLORS.ink, rx: 2 }),
        rect(10, 21, 51, 3, { fill: SCHEMATIC_COLORS.muted, rx: 1.5 }),
        rect(10, 37, 99, 11, { fill: SCHEMATIC_COLORS.quiet, stroke: SCHEMATIC_COLORS.frame, strokeWidth: 1, rx: 2 }),
        rect(10, 53, 99, 11, { fill: SCHEMATIC_COLORS.quiet, stroke: SCHEMATIC_COLORS.frame, strokeWidth: 1, rx: 2 }),
        rect(10, 69, 99, 11, { fill: SCHEMATIC_COLORS.quiet, stroke: SCHEMATIC_COLORS.frame, strokeWidth: 1, rx: 2 }),
        rect(10, 86, 61, 12, { fill: SCHEMATIC_COLORS.soft, stroke: SCHEMATIC_COLORS.accent, strokeWidth: 2, rx: 2 }),
        rect(77, 86, 32, 26, { fill: SCHEMATIC_COLORS.soft, stroke: SCHEMATIC_COLORS.accent, strokeWidth: 2, rx: 2 }),
        rect(19, 124, 90, 4, { fill: SCHEMATIC_COLORS.muted, rx: 2 }),
        rect(30, 136, 79, 5, { fill: SCHEMATIC_COLORS.accent, rx: 2 })
      ]
    }
  },
  {
    id: "editorial-grid",
    name: "编辑网格",
    description: "用不对称列网格平衡标题、主体与辅助资料，适合有编辑感的专题内容。",
    fit_signals: [
      { signal: "copy_multiple", weight: 6, reason: "多组信息需要明确的列关系" },
      { signal: "scenic_visual", weight: 3, reason: "场景可作为网格中的大块视觉" },
      { signal: "formal_or_campaign", weight: 2, reason: "专题或活动内容适合编辑式层级" }
    ],
    avoid_conditions: [
      { signal: "hero_focus_only", penalty: 6, reason: "单一主体不需要编辑网格" },
      { signal: "short_copy", penalty: 2, reason: "过少内容难以支撑列关系" }
    ],
    composition_grammar: "asymmetric title column + hero column + supporting notes",
    slots: ["title", "hero", "subtitle", "supporting_copy", "footer"],
    difference_axes: ["asymmetric_columns", "editorial_rhythm", "information_density"],
    geometry: {
      hero: { x: 0.42, y: 0.31, width: 0.5, height: 0.42 },
      title: { x: 0.08, y: 0.08, width: 0.3, align: "left" },
      copy_mode: "dense_stack",
      asset_mode: "grid"
    },
    schematic: {
      viewBox: VIEW_BOX,
      elements: [
        rect(10, 10, 35, 5, { fill: SCHEMATIC_COLORS.ink, rx: 2 }),
        rect(10, 21, 28, 3, { fill: SCHEMATIC_COLORS.muted, rx: 1.5 }),
        rect(10, 38, 28, 68, { fill: SCHEMATIC_COLORS.quiet, stroke: SCHEMATIC_COLORS.frame, strokeWidth: 1, rx: 2 }),
        rect(47, 38, 62, 55, { fill: SCHEMATIC_COLORS.soft, stroke: SCHEMATIC_COLORS.accent, strokeWidth: 2, rx: 3 }),
        rect(47, 101, 28, 15, { fill: SCHEMATIC_COLORS.quiet, stroke: SCHEMATIC_COLORS.frame, strokeWidth: 1, rx: 2 }),
        rect(80, 101, 29, 15, { fill: SCHEMATIC_COLORS.quiet, stroke: SCHEMATIC_COLORS.frame, strokeWidth: 1, rx: 2 }),
        rect(10, 128, 99, 5, { fill: SCHEMATIC_COLORS.accent, rx: 2 })
      ]
    }
  }
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const LAYOUT_ARCHETYPES = RAW_LAYOUT_ARCHETYPES.map((archetype) => ({
  ...archetype,
  provenance: clone(CATALOG_PROVENANCE)
}));

function compactText(value) {
  return String(value ?? "").toLowerCase();
}

function hasAny(text, terms) {
  return terms.some((term) => text.includes(String(term).toLowerCase()));
}

export function deriveBriefSignals(brief) {
  const copy = Array.isArray(brief?.copy) ? brief.copy : [];
  const copyText = copy.map((item) => String(item?.text ?? "")).join(" ");
  const title = copy.find((item) => /title|headline|标题/i.test(String(item?.role ?? ""))) ?? copy[0] ?? {};
  const roles = copy.map((item) => String(item?.role ?? "").toLowerCase()).join(" ");
  const purposeText = [brief?.purpose, brief?.style?.purpose, brief?.style?.direction, brief?.style?.materials].filter(Boolean).join(" ");
  const mainVisualText = [brief?.main_visual?.description, ...(brief?.main_visual?.asset_refs ?? [])].filter(Boolean).join(" ");
  const allText = compactText([copyText, purposeText, mainVisualText, brief?.constraints?.must_include ?? [], brief?.constraints?.must_not_include ?? []].flat().join(" "));
  const titleText = compactText(title?.text);
  const copyCharacters = [...copyText].length;
  const copyMultiple = copy.length >= 4 || hasAny(roles, ["benefit", "list", "step", "detail", "说明", "要点"]);
  const copyDense = copyCharacters >= 90 || copy.length >= 7 || hasAny(allText, ["地址", "地点", "时间", "规则", "步骤", "参数", "联系方式", "说明", "须知", "报名条件", "schedule", "details"]);
  const heroFocusOnly = copy.length <= 3 && copyCharacters <= 52 && !copyDense;
  const shortCopy = copyCharacters <= 52 && copy.length <= 4;
  const titleShort = [...String(title?.text ?? "")].length <= 12;
  const titleLong = [...String(title?.text ?? "")].length >= 18;
  const dynamic = hasAny(allText, ["运动", "体育", "赛事", "比赛", "速度", "动感", "动态", "对角", "action", "sport", "dynamic", "festival", "live"]);
  const productOrPerson = hasAny(allText, ["人物", "人像", "产品", "商品", "设备", "手机", "平板", "手表", "路由器", "模特", "person", "product"]);
  const scenicVisual = hasAny(allText, ["场景", "空间", "客厅", "城市", "户外", "室内", "背景", "氛围", "故事", "房间", "scene", "lifestyle"]);
  const visualStory = hasAny(allText, ["故事", "生活", "家庭", "旅程", "日常", "体验", "情绪", "氛围", "场景", "story", "lifestyle"]);
  const modularContent = copyMultiple || hasAny(allText, ["模块", "服务", "清单", "功能", "要点", "步骤", "参数", "列表", "benefit", "feature", "list"]);
  const comparisonOrParallel = hasAny(allText, ["对比", "比较", "并列", "左右", "两种", "前后", "对照", "before", "after", "versus", "vs"]);
  const actionOrAnnouncement = hasAny(allText, ["发布", "新品", "活动", "招募", "通知", "公告", "预约", "报名", "购买", "立即", "下载", "发布会", "announcement", "campaign"]);
  const formalOrCampaign = hasAny(allText, ["发布会", "通知", "活动", "课程", "招募", "会议", "宣讲", "公告", "海报", "campaign", "event", "poster"]);
  const premiumOrCalm = hasAny(allText, ["高端", "精品", "极简", "留白", "克制", "高级", "奢华", "premium", "minimal", "calm", "luxury"]);
  const formalQuiet = hasAny(allText, ["正式", "稳重", "克制", "专业", "报告", "通知", "formal", "quiet"]);
  return {
    hero_focus: productOrPerson || scenicVisual || heroFocusOnly,
    hero_focus_only: heroFocusOnly,
    short_copy: shortCopy,
    title_short: titleShort,
    title_long: titleLong,
    copy_multiple: copyMultiple,
    copy_dense: copyDense,
    modular_content: modularContent,
    product_or_person: productOrPerson,
    scenic_visual: scenicVisual,
    visual_story: visualStory,
    comparison_or_parallel: comparisonOrParallel,
    dynamic,
    action_or_announcement: actionOrAnnouncement,
    formal_or_campaign: formalOrCampaign,
    formal_quiet: formalQuiet,
    premium_or_calm: premiumOrCalm,
    copy_characters: copyCharacters,
    copy_count: copy.length
  };
}

export function validateLayoutArchetypeCatalog(catalog = LAYOUT_ARCHETYPES) {
  const errors = [];
  if (!Array.isArray(catalog) || catalog.length < 8) errors.push("catalog must contain at least 8 archetypes");
  const ids = new Set();
  for (const [index, archetype] of (catalog ?? []).entries()) {
    if (!archetype || typeof archetype !== "object") {
      errors.push(`archetype[${index}] must be an object`);
      continue;
    }
    if (typeof archetype.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(archetype.id)) errors.push(`archetype[${index}] has an invalid id`);
    if (ids.has(archetype.id)) errors.push(`archetype[${index}] has a duplicate id`);
    ids.add(archetype.id);
    for (const key of ["name", "composition_grammar"]) if (typeof archetype[key] !== "string" || !archetype[key].trim()) errors.push(`${archetype.id ?? index}.${key} is required`);
    if (!Array.isArray(archetype.fit_signals) || archetype.fit_signals.length < 1) errors.push(`${archetype.id ?? index}.fit_signals is required`);
    if (!Array.isArray(archetype.avoid_conditions)) errors.push(`${archetype.id ?? index}.avoid_conditions is required`);
    if (!Array.isArray(archetype.slots) || archetype.slots.length < 2) errors.push(`${archetype.id ?? index}.slots is required`);
    if (!Array.isArray(archetype.difference_axes) || archetype.difference_axes.length < 2) errors.push(`${archetype.id ?? index}.difference_axes must contain at least 2 axes`);
    if (archetype.provenance?.kind !== "product-owned" || archetype.provenance?.owner !== "layout-guided-ai-imagen" || archetype.provenance?.inspiration?.exhaustive_catalog !== false) errors.push(`${archetype.id ?? index}.provenance must declare product ownership and non-exhaustive official inspiration`);
    if (!archetype.schematic || archetype.schematic.viewBox !== VIEW_BOX || !Array.isArray(archetype.schematic.elements) || archetype.schematic.elements.length < 2) errors.push(`${archetype.id ?? index}.schematic must define SVG elements in ${VIEW_BOX}`);
    const hero = archetype.geometry?.hero;
    if (!hero || !["x", "y", "width", "height"].every((key) => Number.isFinite(hero[key]) && hero[key] > 0 && hero[key] <= 1)) errors.push(`${archetype.id ?? index}.geometry.hero is invalid`);
  }
  return { valid: errors.length === 0, errors };
}

export function getLayoutArchetype(archetypeId) {
  const archetype = LAYOUT_ARCHETYPES.find((item) => item.id === archetypeId);
  return archetype ? clone(archetype) : null;
}

export function listLayoutArchetypes() {
  return {
    schema_version: SCHEMA_VERSION,
    provenance: clone(CATALOG_PROVENANCE),
    selection_policy: clone(SELECTION_POLICY),
    archetypes: clone(LAYOUT_ARCHETYPES)
  };
}

export function scoreLayoutArchetype(archetype, signals) {
  let score = 50;
  const matched = [];
  const avoided = [];
  for (const signal of archetype.fit_signals ?? []) {
    if (signals?.[signal.signal]) {
      score += Number(signal.weight) || 0;
      matched.push(signal.reason);
    }
  }
  for (const condition of archetype.avoid_conditions ?? []) {
    if (signals?.[condition.signal]) {
      score -= Number(condition.penalty) || 0;
      avoided.push(condition.reason);
    }
  }
  return { score, matched, avoided };
}

function axisOverlap(left, right) {
  const axes = new Set(left.difference_axes ?? []);
  return (right.difference_axes ?? []).filter((axis) => axes.has(axis)).length;
}

export function selectLayoutArchetypes(brief, { candidateCount = 3 } = {}) {
  if (!Number.isInteger(candidateCount) || candidateCount < 2 || candidateCount > 3) throw new Error("candidateCount must be 2 or 3");
  const signals = deriveBriefSignals(brief);
  const ranked = LAYOUT_ARCHETYPES.map((archetype, catalogIndex) => ({
    archetype,
    catalogIndex,
    ...scoreLayoutArchetype(archetype, signals)
  })).sort((left, right) => right.score - left.score || left.catalogIndex - right.catalogIndex || left.archetype.id.localeCompare(right.archetype.id));
  const selected = [];
  const remaining = [...ranked];
  while (selected.length < candidateCount && remaining.length) {
    let bestIndex = 0;
    let bestAdjusted = -Infinity;
    for (const [index, item] of remaining.entries()) {
      const overlapPenalty = selected.reduce((total, chosen) => total + axisOverlap(chosen, item.archetype) * 6, 0);
      const adjusted = item.score - overlapPenalty;
      if (adjusted > bestAdjusted || (adjusted === bestAdjusted && item.catalogIndex < remaining[bestIndex].catalogIndex)) {
        bestAdjusted = adjusted;
        bestIndex = index;
      }
    }
    const item = remaining.splice(bestIndex, 1)[0];
    const matches = item.matched.slice(0, 2);
    const rationale = matches.length
      ? `匹配${matches.join("；")}；以${item.archetype.difference_axes.slice(0, 2).join("、")}与其他候选拉开结构差异。`
      : `在当前信号不足时提供稳定备选；以${item.archetype.difference_axes.slice(0, 2).join("、")}与其他候选拉开结构差异。`;
    selected.push({
      ...clone(item.archetype),
      selection_score: item.score,
      selection_rationale: rationale,
      matched_signals: matches,
      avoided_signals: item.avoided.slice(0, 2)
    });
  }
  return {
    schema_version: SCHEMA_VERSION,
    candidate_count: selected.length,
    signals,
    selection_policy: clone(SELECTION_POLICY),
    selected
  };
}

const catalogValidation = validateLayoutArchetypeCatalog();
if (!catalogValidation.valid) throw new Error(`invalid layout archetype catalog: ${catalogValidation.errors.join("; ")}`);

export { LAYOUT_ARCHETYPES, SCHEMA_VERSION as LAYOUT_ARCHETYPES_SCHEMA_VERSION, VIEW_BOX as LAYOUT_ARCHETYPE_VIEW_BOX };
export { CATALOG_PROVENANCE as LAYOUT_ARCHETYPE_CATALOG_PROVENANCE, SELECTION_POLICY as LAYOUT_ARCHETYPE_SELECTION_POLICY };
