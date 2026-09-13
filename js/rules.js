/**
 * Shared rule text for both builds.
 *
 * The game rules live here so the solo page and the online page can never
 * drift apart; each build appends its own control list.
 */

import { h } from './dom.js';

export const GAME_RULES = [
  {
    title: '棋盘与落子',
    items: [
      '棋盘由三种格子组成：深色“封闭”格不能落子，浅色“可走”格可以落子，圆形棋子占据的格子不能再落子。',
      'A 方（蓝）先手，双方轮流在任意“可走”格落子。',
    ],
  },
  {
    title: '造路',
    items: [
      '每次落子后自动“造路”：以新棋子为起点，向上、下、左、右四个方向扫描；若在遇到对手棋子之前先遇到己方棋子，两者之间的所有封闭格都变成“可走”格。',
      '对手棋子会阻断该方向；斜向不会造路；每个方向只使用遇到的第一枚己方棋子。',
      '造路只把封闭格变成可落子格，不会自动补上棋子——所以每落一手，棋盘都会为双方多开一些位置。',
    ],
  },
  {
    title: '胜负',
    items: [
      '任意一方在水平、垂直或两条对角线上连成四子（含五连及以上）即获胜。',
      '当棋盘上不再有“可走”格且无人四连时为和棋。',
      '因此双方既要防守对手的四连，也要用造路为自己打开新的落点。',
    ],
  },
];

export const SOLO_CONTROLS = [
  {
    title: '操作',
    items: [
      '左键点击浅色格落子；侧栏可切换 A/B 方由“玩家 / 随机 AI / 思考型 AI”控制。',
      '“交换双方”按钮可互换 A、B 两方的身份；也可以一键套用“双人对战 / 我执 A / 我执 B / AI 自对弈”预设。',
      '快捷键：U 悔棋（撤销）· R 重开 · N 新棋盘 · E 编辑 · T AI 参数 · S 棋谱 · P 保存当前棋盘 · H 规则 · 1/2 切换 A、B 方控制。',
      '棋盘编辑器：1-4 切换工具（封闭 / 可走 / A 棋子 / B 棋子），左键涂抹、右键擦除，可调整尺寸到 4-40。',
    ],
  },
];

export const ONLINE_CONTROLS = [
  {
    title: '联机操作',
    items: [
      '房主创建房间时选择初始棋盘与先后手，把邀请链接发给对手；对手打开链接即自动加入并执另一方。',
      '轮到你时点击浅色格落子；落子会通过房间同步给对手（约 1 秒内可见），双方看到的是同一盘棋。',
      '悔棋需要对手同意：如果你刚下完（轮到对手），悔棋只撤回你那一手；如果对手已经回应（轮到你），悔棋会撤回双方各一手，回到你上一手之前。',
      '对局结束后由房主决定“再来一局”或“再来一局（交换先后手）”；房主还可以关闭房间，关闭后房间号会被释放。',
      '刷新页面不会丢局：重新打开链接即可继续，棋局由房间里的着法列表重新播放得到。',
    ],
  },
];

/** Render rule sections into a container (used by both pages’ help panel). */
export function renderRuleSections(container, sections) {
  for (const section of sections) {
    container.append(h('h3', { text: section.title }));
    container.append(
      h(
        'ul',
        { class: 'rule-list' },
        ...section.items.map((item) => h('li', { text: item })),
      ),
    );
  }
  return container;
}
