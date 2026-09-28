import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const frontendRoot = path.resolve(new URL('..', import.meta.url).pathname);
const sourceRoot = path.join(frontendRoot, 'src');
const read = (file) => fs.readFileSync(path.join(sourceRoot, file), 'utf8');

const api = read('api.ts');
const store = read('store.ts');
const style = read('style.css');
const mainPage = read('views/MainPage.vue');
const settingsPage = read('views/SettingsPage.vue');
const rootApp = read('App.vue');
const runtime = read('runtime.ts');
const appBar = read('views/AppBar.vue');
const publicIcon = fs.readFileSync(path.join(frontendRoot, 'public/icon.svg'), 'utf8');
const switchComponent = read('ui/SlSwitch.vue');
const sliderComponent = read('ui/SlSlider.vue');
const viteConfig = fs.readFileSync(path.join(frontendRoot, 'vite.config.ts'), 'utf8');
const selectComponent = read('ui/SlSelect.vue');
const slListView = read('ui/SlListView.vue');
const slButton = read('ui/SlButton.vue');
const slIcon = read('ui/SlIcon.vue');
const playerBar = read('views/PlayerBar.vue');
const fullscreenPlayer = read('views/FullscreenPlayer.vue');
const voiceSettings = read('views/settings/VoiceSettings.vue');
const scheduleSettings = read('views/settings/ScheduleSettings.vue');
const modePopup = read('views/PlayerModePopup.vue');
const speedPopup = read('views/PlayerSpeedPopup.vue');
const toolboxSettings = read('views/settings/ToolboxSettings.vue');
const volumePopup = read('views/PlayerVolumePopup.vue');
const sleepTimerPopup = read('views/PlayerSleepTimerPopup.vue');
const progress = read('views/PlayerProgress.vue');
const songRow = read('views/SongRow.vue');
const covers = read('covers.ts');
const playlistHandler = fs.readFileSync(path.join(frontendRoot, '../src/handlers/playlist.ts'), 'utf8');
const scheduleHandler = fs.readFileSync(path.join(frontendRoot, '../src/handlers/schedule.ts'), 'utf8');
const lyricHandler = fs.readFileSync(path.join(frontendRoot, '../src/handlers/lyric.ts'), 'utf8');
const voiceCommandHandler = fs.readFileSync(path.join(frontendRoot, '../src/handlers/voice_command.ts'), 'utf8');
const voiceEngine = fs.readFileSync(path.join(frontendRoot, '../src/voicecmd/engine.ts'), 'utf8');
const playerManager = fs.readFileSync(path.join(frontendRoot, '../src/player/manager.ts'), 'utf8');
const pluginTypes = fs.readFileSync(path.join(frontendRoot, '../src/types.ts'), 'utf8');
const favorites = fs.readFileSync(path.join(frontendRoot, '../src/utils/favorites.ts'), 'utf8');
const app = fs.readFileSync(path.join(frontendRoot, '../static/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(frontendRoot, '../static/index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(frontendRoot, '../plugin.json'), 'utf8'));

assert.equal(manifest.renderEngine, 'webview');
assert.match(html, /static\/js\/app\.js/);
assert.match(html, /static\/css\/style\.css/);
assert.match(api, /apiGet\(path\)/);
assert.match(api, /postEnvelope/);
assert.match(store, /status\/ws/);
assert.match(store, /startStatusPolling/);
// 状态 WebSocket 的断线回收（songloft-org/songloft-plugin-miot#96 第 4 条）：
// close 必须带关闭码，否则部分实现会在派发 close 时抛错、onclose 永不触发；
// onerror 必须自己走完恢复，不能指望 close 事件兜底。
assert.match(store, /const STATUS_CLOSE_CODE = 1000/);
assert.match(store, /socket\.close\(STATUS_CLOSE_CODE, STATUS_CLOSE_REASON\)/);
assert.doesNotMatch(store, /\.close\(\)/);
assert.match(store, /statusSocket\.onerror = \(\) => abandonStatusSocket\(gen, true\)/);
assert.match(store, /STATUS_OPEN_TIMEOUT_MS/);
// readyState 常量只能读实例：部分宿主的 WebSocket 实现把常量挂在实例上，
// 类上没有静态同名成员，`WebSocket.OPEN` / `WebSocket.CLOSED` 可能是 undefined。
assert.doesNotMatch(store, /=== WebSocket\.(OPEN|CLOSED)/);
assert.match(store, /statusSocket\.readyState === statusSocket\.OPEN/);
assert.match(store, /external_search_sources/);
assert.match(store, /selectCurrentPlaylistOnEntry/);
assert.match(store, /await selectCurrentPlaylistOnEntry\(\)/);
assert.match(store, /pendingConfigPatch/);
assert.match(store, /while \(pendingConfigPatch\)/);
assert.doesNotMatch(switchComponent, /flutter-cupertino-switch/);
// SlButton 不得恢复原生控件分支：单一 HTML 实现（songloft-org/songloft#440）。
assert.doesNotMatch(slButton, /flutter-cupertino-button/);
assert.match(selectComponent, /getBoundingClientRect\(\)/);
assert.match(selectComponent, /sl-select-option-on/);
assert.match(selectComponent, /sl-select-wrap-open/);
assert.match(selectComponent, /sl-select-panel-fixed/);
assert.match(selectComponent, /sl-select-backdrop/);
assert.match(selectComponent, /addEventListener\('pointerdown', onPointerDown, true\)/);
assert.match(selectComponent, /addEventListener\('keydown', onKeydown, true\)/);
// 面板定位：优先向下 + 高度夹到该侧可用空间 + 下方不够时滚动让位，且滚动产生的
// scroll 回调必须被 repositioning 吞掉。旧逻辑恒用 320px 算空间，在 APP 的 ~520px
// 视口里必然翻到上方盖住表单（songloft-org/songloft-plugin-miot#80）。
assert.match(selectComponent, /function scrollNearestBy/);
assert.match(selectComponent, /positionPanel\(allowScroll = false\)/);
assert.match(selectComponent, /nextTick\(\(\) => positionPanel\(true\)\)/);
assert.match(selectComponent, /if \(!opened\.value \|\| repositioning\) return;/);
// fixed 的面板本体不能自己滚动：一滚面板就整体下移（songloft-org/songloft#397）。
// 滚动必须落在内层，且 window 上的 capture scroll 监听要忽略面板内部的滚动。
assert.doesNotMatch(style, /\.sl-select-panel \{[^}]*overflow(-y)?: (auto|scroll)/);
assert.match(style, /\.sl-select-panel \{[^}]*overflow: hidden/);
assert.match(style, /\.sl-select-panel-scroll \{[^}]*overflow-y: auto/);
assert.match(selectComponent, /class="sl-select-panel-scroll"/);
assert.match(selectComponent, /scrollStyle\.value = \{ maxHeight: `\$\{Math\.round\(height\) - PANEL_BORDER - searchH\}px` \}/);
assert.doesNotMatch(selectComponent, /maxHeight: `\$\{Math\.round\(height\)\}px`/);
assert.match(selectComponent, /if \(target && panel\.value\?\.contains\(target\)\) return;/);
// 歌单搜索（songloft-org/songloft#410）：重构时把旧版带搜索框的歌单弹层换成了
// 通用 SlSelect，过滤功能整个丢了。搜索行在滚动容器外，所以面板总高与内层 maxHeight
// 都必须给它让位；SEARCH_ROW_H 与 CSS 的 height 要对齐，否则面板会算矮一行。
assert.match(selectComponent, /searchable\?: boolean/);
// searchable 的下拉走自绘面板：原生 <select> 塞不进搜索框。
// 条件必须是 searchable 而非 showSearch，否则选项数跨过阈值时渲染分支会来回跳。
assert.match(selectComponent, /v-if="searchable"/);
assert.match(selectComponent, /const SEARCH_MIN_OPTIONS = 5/);
assert.match(selectComponent, /props\.searchable && props\.options\.length > SEARCH_MIN_OPTIONS/);
assert.match(selectComponent, /const SEARCH_ROW_H = 48/);
assert.match(style, /\.sl-select-panel-search \{[^}]*height: 48px/);
assert.match(selectComponent, /const searchH = showSearch\.value \? SEARCH_ROW_H : 0/);
// 面板外高必须把「滚动容器 padding + 面板边框」都算进去，内层 maxHeight 再减回边框。
// 少算边框 2px 时哪怕只有 1 项，maxHeight 也会比内容小 2px、溢出出滚动条
// （小屏 itemH=40 必现）—— 这正是「只有 1 首也出滚动条」的根因。
assert.match(selectComponent, /const PANEL_BORDER = 2/);
assert.match(selectComponent, /const SCROLL_PAD = 8/);
assert.match(selectComponent, /rows\.value\.length \* itemH \+ SCROLL_PAD\) \+ searchH \+ PANEL_BORDER/);
assert.match(selectComponent, /itemH \* MIN_ROWS_BELOW \+ SCROLL_PAD \+ searchH \+ PANEL_BORDER/);
// 面板高度的下界也要含搜索行：否则空间被挤到极小时 height 被钳到 itemH，
// 内层 maxHeight 变负、max-height 声明失效，选项会被 overflow:hidden 吃掉
assert.match(selectComponent, /Math\.max\(itemH \+ searchH, Math\.min\(desiredH/);
// 匹配 searchText 优先于 label：歌单 label 带「(歌曲数)」，拿它匹配会让输入数字命中一片。
// `||` 必须转义 —— 正则里裸写 || 是「空或空」的交替，能匹配任何字符串，断言会变永真。
assert.match(selectComponent, /\(option\.searchText \|\| option\.label\)\.toLowerCase\(\)\.includes\(keyword\.value\)/);
// 打开与选中都要复位关键词，否则下次打开列表已被上次的词过滤、而搜索框是空的
assert.match(selectComponent, /query\.value = '';\n  openSelect\.value = id;/);
// 刻意不 autofocus：打开下拉即调起输入法会把面板压到不便选择（旧版 playlist.js 同样权衡）。
// 只禁真正的属性/调用，别把说明这件事的注释也一起禁掉。
assert.doesNotMatch(selectComponent, /\.focus\(\)|autofocus(=|\s*\/?>)/);
// 过滤后行数变了要重定位，否则向上展开的面板与触发器之间会裂开空隙
assert.match(selectComponent, /watch\(keyword, \(\) => \{/);
assert.match(selectComponent, /sl-select-empty/);
// 三处歌单/歌曲下拉都要接上，且歌单要传纯名称做匹配文本
assert.match(mainPage, /searchable search-placeholder="搜索歌单"/);
assert.match(mainPage, /searchText: p\.name/);
assert.match(scheduleSettings, /searchText: playlist\.name/);
// 歌单下拉走 @update:model-value="onPlaylistChange" 而非 v-model，用来切歌单时清 songId
assert.match(scheduleSettings, /:model-value="playlistId"[^>]*searchable search-placeholder="搜索歌单"/);
assert.match(scheduleSettings, /v-model="songId"[^>]*searchable search-placeholder="搜索歌曲"/);
assert.match(voiceSettings, /searchText: p\.name/);
assert.match(voiceSettings, /external_search_playlist_id"[^>]*searchable search-placeholder="搜索歌单"/);
assert.match(mainPage, /openSelect\.value = null/);
assert.match(mainPage, /@click="openDevicePicker"/);
// wrap 不再创建层叠上下文，面板 z-index 300 直接在根层叠上下文生效（songloft-org/songloft#432）
assert.doesNotMatch(style, /\.sl-select-wrap\b[^{]*\{[^}]*z-index/);
assert.match(style, /\.miot-main-appbar[\s\S]*position: fixed/);
assert.match(style, /\.settings-scroll-body[^}]*height: calc\(100dvh - 56px\)[^}]*overflow: hidden/);
assert.match(style, /\.switch-track::after[^}]*transition: transform/);
assert.match(style, /\.switch input:checked ~ \.switch-track::after[^}]*translateX\(20px\)/);
assert.match(settingsPage, /class="settings-scroll-body"/);
assert.match(settingsPage, /openSelect\.value = null/);
assert.match(settingsPage, /<AppBar :title="appbarTitle" back @back="back"/);
assert.match(settingsPage, /window\.innerWidth < 600/);
assert.match(style, /--miot-nav-width: 280px/);
assert.match(style, /\.settings-nav-item[^}]*min-height: 60px[^}]*padding: 10px 16px/);
assert.match(style, /\.settings-mobile-menu \.settings-nav-title[^}]*font-size: 16px[^}]*line-height: 24px/);
assert.match(runtime, /page: 'main' as AppPage/);
assert.match(runtime, /export function openPage/);
assert.match(runtime, /export function closePage/);
assert.match(runtime, /devicePickerOpen/);
assert.match(runtime, /if \(state\.confirm\.open\) \{[\s\S]*resolveConfirm\(false\)/);
assert.match(runtime, /navigation\.devicePickerOpen = false/);
assert.match(rootApp, /v-if="navigation\.page === 'settings'"/);
// 刻意不套 KeepAlive（songloft-org/songloft-plugin-miot#81 历史结论）。
assert.match(rootApp, /<FullscreenPlayer v-if="navigation\.page === 'player'" \/>/);
assert.doesNotMatch(rootApp, /<KeepAlive>/);
assert.doesNotMatch(rootApp, /FullscreenPlayer v-show/);
assert.doesNotMatch(rootApp, /settingsOpen|playerOpen/);
assert.doesNotMatch(style, /\.page-overlay/);
assert.doesNotMatch(appBar, /<SlIcon|name="speaker"/);
assert.match(publicIcon, /viewBox="0 0 256 256"/);
assert.match(publicIcon, /<circle[^>]+fill="#E3EEFF"/);
assert.match(publicIcon, /<path[^>]+fill="#3B6FE0"/);
assert.match(publicIcon, /M680-80H280/);
assert.match(mainPage, /icon="speaker_group" title="选择设备"/);
assert.doesNotMatch(mainPage, /title="URL 播放"|title="文字播报"/);
assert.match(mainPage, /measureListHeight/);
assert.match(mainPage, /listBottom - listTop/);
assert.match(mainPage, /window\.addEventListener\('resize', remeasureList\)/);
assert.match(mainPage, /miot-page-with-player/);
assert.match(style, /--miot-list-height: clamp\(240px, calc\(100vh - 254px\), 720px\)/);
assert.match(style, /\.sl-list-view\s*\{[^}]*height: var\(--miot-list-height\)/);
assert.match(slListView, /class="sl-list-view"/);
assert.doesNotMatch(mainPage, /:height="'var\(--miot-list-height\)'"/);

// #96 回归测试：歌曲列表必须是定高双向虚拟列表。
// 以前整份歌单一次性渲染，1900 首就是 1900 个 SongRow + 1900 个封面请求排在 3 个并发槽后面，
// 表现为“点定位卡好久、封面全空白、拖动很卡”。开销全在 JS 侧，
// 所以必须在 JS 侧就只渲染窗口内的行。
assert.match(mainPage, /renderedSongs = computed\(\(\) => visibleSongs\.value\.slice\(windowStart\.value, windowEnd\.value\)\)/);
assert.match(mainPage, /leadSpacerHeight = computed\(\(\) => windowStart\.value \* rowHeight\.value\)/);
assert.match(mainPage, /tailSpacerHeight = computed\(\(\) => Math\.max\(0, \(totalSongs\.value - windowEnd\.value\) \* rowHeight\.value\)\)/);
// 行号必须是歌单里的绝对序号，不能是窗口内的下标（否则序号和播放的都是错的那首）。
assert.match(mainPage, /:index="windowStart \+ index"/);
// 占位条常驻（高度可为 0）：摘掉会让原生 ListView 的子节点索引整体错位。
assert.match(mainPage, /class="song-list-spacer" :style="\{ height: `\$\{leadSpacerHeight\}px` \}"/);
assert.match(mainPage, /class="song-list-spacer" :style="\{ height: `\$\{tailSpacerHeight\}px` \}"/);
// 占位条按“行号 × 行高”算，所以行高必须是精确值，不能只给 min-height。
assert.match(style, /\.song-row \{[^}]*height: var\(--miot-row-height\)/);
assert.doesNotMatch(style, /\.song-row \{[^}]*min-height: var\(--miot-row-height\)/);
// 列表必须绑 @scroll：不绑窗口就永不推进。
assert.match(slListView, /<div[\s\S]*?@scroll="emit\('scroll', \$event\)"/);
// #444 回归测试：歌单列表是 div 滚动容器（overflow 滚动的 scrollHeight 是子元素
// 真实高度之和，行为确定）。
assert.doesNotMatch(slListView, /webf-list-view/);
// #448 回归测试：窗口盖不住可视区时必须无条件跟上，不能被 WINDOW_STEP_ROWS 滞后阈值挡住。
// desired 被 max(0, …) 削去上缓冲，顶部前 12 行里窗口起点就等于首个可见行；快滑下去再快滑回顶时，
// 回滑途中的采样会把 rawWindowStart 停在 1..3，回到 scrollTop=0 那次漂移只有 1..3 行被跳过，
// 于是顶部前几首歌永久不渲染（只剩占位条撑出的 64..192px 空白，120ms 轮询也不自愈）。
assert.match(mainPage, /const uncovered = windowStart\.value > firstVisible \|\| windowEnd\.value < lastVisible/);
assert.match(mainPage, /if \(uncovered \|\| Math\.abs\(desired - rawWindowStart\.value\) >= WINDOW_STEP_ROWS\)/);
// 事件不来的客户端上还要有轮询兜底，否则往下滚全是空白，比不虚拟化更糟。
assert.match(mainPage, /windowPollTimer = setInterval/);
assert.match(mainPage, /clearInterval\(windowPollTimer\)/);
// #374 回归测试：定位当前播放歌曲前必须校验布局已完成（否则 scrollTop 会被算成 0，
// 表现为“定位功能始终回第一屏”），不允许在拿到零尺寸测量值时直接应用 scrollTop。
// 现在改成定高换算，判据也从“行的尺寸”变成“可视区高度 + 写入后 scrollTop 是否真落到位”。
assert.match(mainPage, /const viewport = list\.clientHeight\(\);\s*\n\s*if \(viewport <= 0\) \{/);
assert.match(mainPage, /locateTimer = setTimeout\(\(\) => scrollToIndex\(index, attempt \+ 1\)/);
assert.match(mainPage, /if \(Math\.abs\(list\.scrollTop\(\) - target\) > rowHeight\.value\) scrollToIndex\(index, attempt \+ 1\)/);
// 封面并发槽必须有兜底归还：load/error 都不发时，漏满 3 个槽后列表封面永久空白。
assert.match(songRow, /COVER_SLOT_WATCHDOG_MS/);
assert.match(songRow, /coverWatchdog = setTimeout/);
assert.match(slListView, /defineEmits<\{ scroll/);
assert.match(style, /\.player-bar-shell[\s\S]*position: fixed/);
assert.match(style, /\.song-cover[^}]*width: 48px[^}]*height: 48px/);
assert.match(songRow, /class="song-cover-img"/);
assert.match(songRow, /acquireCoverSlot/);
assert.match(covers, /access_token/);
assert.match(covers, /MAX_CONCURRENT_COVERS = 3/);
assert.match(playerBar, /useSongCover\(\(\) => state\.player\.current_song, 96\)/);
assert.match(fullscreenPlayer, /useSongCover\(\(\) => state\.player\.current_song, 768\)/);
assert.match(playerBar, /@error="onCoverError"/);
assert.match(fullscreenPlayer, /@error="onCoverError"/);

// #86 回归测试（第 1 条「切标签回来封面永久丢失」）。
// 上一次修的方式是「监听 visibilitychange 把 coverFailed 置回 false」，两处都不成立：
//   ① 宿主在 Tab 切换时不一定派发 visibilitychange（现已由客户端的 setPageVisible 补上真通知）；
//   ② 光清标记不够 —— 缓存可能持有已失效的解码结果（空白且**不发 error**），
//      src 不变就不会重新加载。必须换掉 URL 才能触发重新解码。
assert.match(covers, /export function useSongCover/);
// 换 URL 的 nonce：这是与上一版修复的本质区别，不能退回成只清标记。
assert.match(covers, /appendQuery\(url, '_r', String\(nonce\.value\)\)/);
assert.match(covers, /nonce\.value \+= 1/);
// 失败标记不能是粘滞闩锁：一次瞬时失败不该让这首歌整个会话都没封面。
// 重试次数要有上限，真 404 不能无限重试。
assert.match(covers, /MAX_COVER_RETRIES = \d+/);
assert.match(covers, /retries >= MAX_COVER_RETRIES/);
// 加载成功要把重试预算还回去：插件 Tab 靠 Offstage 保活，同一个组件实例可能活几小时，
// 预算必须是「每段连续失败」而不是「每首歌」，否则偶发失败两次就再也不重试了。
assert.match(covers, /function onLoad\(\): void \{[\s\S]{0,120}?retries = 0;/);
assert.match(playerBar, /@load="onCoverLoad"/);
assert.match(fullscreenPlayer, /@load="onCoverLoad"/);
assert.match(fullscreenPlayer, /@load="onCoverMobileLoad"/);
// 放弃重试时必须撤掉还在飞的定时器：否则它会在 1.2s 后把已经放弃的图又复活一次
// （浏览器实测复现过，那条 `真 404 不无限重试` 的保证会被这颗定时器绕过）。
assert.match(covers, /if \(retries >= MAX_COVER_RETRIES\) \{[\s\S]{0,400}?clearRetryTimer\(\);\s*failed\.value = true;/);
assert.match(covers, /addEventListener\('visibilitychange'/);
assert.match(covers, /removeEventListener\('visibilitychange'/);
// 全屏页桌面/移动两个 stage 同时在 DOM 里，必须用不同的 w=：同 URL 的两个 <img>
// 共享同一份缓存，会互相把对方已解码的图毙掉。
assert.match(fullscreenPlayer, /useSongCover\(\(\) => state\.player\.current_song, 640\)/);

// #96 第 3 次复发的回归测试：换 URL 还不够，必须换掉 <img> 元素本身。
// 判据是用户实测的「封面丢失后**切歌也不出图**」—— 换歌本来就会换 src 重新加载，
// 连它都救不回来，说明坏的是元素的绘制链路本身。
// 只有让 Vue 卸掉旧 <img> 重建，才能重走全新的挂载路径。
assert.match(covers, /epoch: Ref<number>/);
assert.match(covers, /epoch\.value \+= 1/);
assert.match(playerBar, /<img [^>]*:key="coverEpoch"/);
assert.match(fullscreenPlayer, /<img [^>]*:key="coverEpoch"/);
assert.match(fullscreenPlayer, /<img [^>]*:key="coverMobileEpoch"/);
// epoch 必须单调递增：换歌时 nonce 归 0 是对的（URL 本来就变了），但 key 一旦回退，
// Vue 就有机会复用到坏掉的旧元素。
assert.doesNotMatch(covers, /epoch\.value = 0/);
// load / error 一个都不来时的看门狗：加载链路整体卡死时页面侧没有任何可观测事件，
// onError 的重试路径永远不会被触发，必须自己补一次。
assert.match(covers, /COVER_VISIBILITY_WATCHDOG_MS/);
assert.match(covers, /armWatchdog\(\);/);
// 每个可见期只补一次，别把「这张图真的是 404」变成无限重建。
assert.match(covers, /if \(watchdogUsed\) return;/);
// load / error 到了就要撤掉看门狗，否则它会在 1.5s 后无谓地把已经好了的图重建一次。
assert.match(covers, /function onLoad\(\): void \{\s*clearWatchdog\(\);/);
assert.match(covers, /function onError\(\): void \{\s*clearWatchdog\(\);/);
assert.match(fullscreenPlayer, /@error="onCoverMobileError"/);

// #86 回归测试（第 2 条「miot 收藏后曲库红心不同步」）。
// 必须走 `SongloftPlugin.favorite.refresh`。上一版写的是 `SongloftPlugin.invokeHost`，
// 而 invokeHost 当时只挂在内部句柄 window.__SongloftInternal、公开对象里并没有，
// 于是可选调用把它静默吞掉、一个字节都没发出去。
assert.match(runtime, /export function notifyHostFavorite/);
assert.match(runtime, /SongloftPlugin\?\.favorite\?\.refresh\?\./);
assert.match(playerBar, /notifyHostFavorite\(id, result\.is_favorited\)/);
assert.match(fullscreenPlayer, /notifyHostFavorite\(id, result\.is_favorited\)/);
// env.d.ts 是手写的宿主 API 声明，必须与 common.js 的公开字面量一致。
// 声明一个宿主并不提供的方法，等于让 TS 替一段死代码背书 —— 这就是上面那次静默失败的成因。
// 只禁「声明」，不禁注释里提它——那段注释正是记录这次踩坑的。
const envTypes = fs.readFileSync(path.join(frontendRoot, 'env.d.ts'), 'utf8');
assert.doesNotMatch(envTypes, /^\s*invokeHost\?\(/m);
assert.match(envTypes, /favorite\?: \{/);

// 搜索框直接做 flex item，`flex: 1` 生效（songloft-org/songloft-plugin-miot#86 结论），
// 不要包一层 div 承担 flex。
assert.match(style, /\.search-bar input\s*\{[^}]*flex: 1/);
assert.match(voiceSettings, /class="command-keywords"/);
assert.match(voiceSettings, /addKeyword\(command, index\)/);
assert.match(voiceSettings, /removeKeyword\(command, index, keywordIndex\)/);
assert.match(voiceSettings, /setCommandEnabled\(index, \$event\)/);
assert.match(voiceSettings, /saveVoiceCommands\(\[\]\)/);
assert.match(voiceSettings, /device_id: state\.currentDeviceId/);
assert.match(voiceSettings, /account_id: state\.currentAccountId/);
assert.match(voiceSettings, /commandInputVersions/);
assert.match(style, /\.inline-fields\s*\{[^}]*flex-wrap: wrap/);
assert.match(style, /\.card\.miot-card\s*\{[^}]*padding: 0/);
assert.match(style, /\.player-mini-progress[\s\S]*height: 2px/);
// 1a7a63a 起播放条不再复用 <PlayerProgress mini>，改成自带的 player-bar-progress，
// 这条断言当时漏改、一直是红的。
assert.match(playerBar, /class="player-bar-progress"[\s\S]*player-bar-progress-fill/);
assert.match(playerBar, /@click="openPlayer"/);
// 1a7a63a 起宽屏播放条带上了「播放模式 / 音量 / 延迟停止 / 停止」工具区，窄屏由
// media query 隐藏。原来那两条 doesNotMatch 已与设计相反、一直是红的，改成正向断言。
assert.match(playerBar, /class="player-bar-tools"/);
assert.match(playerBar, /@change="setVolume"/);
assert.match(style, /@media \(max-width: 760px\)[\s\S]*\.player-bar-tools \{ display: none; \}/);
assert.doesNotMatch(playerBar, /mini-mode-control|mini-stop-control/);
assert.match(modePopup, /value: 'single'/);
assert.match(modePopup, /value: 'random'/);
assert.match(modePopup, /value: 'singlePlay'.*label: '单曲播放'.*icon: 'looks_one'/);
assert.doesNotMatch(modePopup, /value: 'repeat_one'|value: 'shuffle'/);
assert.match(modePopup, /const panelWidth = mobile \? 140 : 160/);
assert.match(modePopup, /height: `\$\{panelHeight\}px`/);
assert.match(modePopup, /Math\.max\(edgeInset, Math\.min\(centeredLeft/);
assert.match(modePopup, /aboveTop < edgeInset \? rect\.bottom \+ gap : aboveTop/);
assert.match(style, /\.player-mode-popup\s*\{[^}]*position: fixed[^}]*width: 160px/);
assert.match(style, /@media \(max-width: 599px\)[\s\S]*\.player-mode-popup\s*\{[^}]*width: 140px/);
assert.match(style, /@media \(max-width: 599px\)[\s\S]*\.player-mode-option\s*\{[^}]*height: 44px/);
assert.match(toolboxSettings, /ref\('https:\/\/lhttp\.qtfm\.cn\/live\/4915\/64k\.mp3'\)/);
assert.doesNotMatch(toolboxSettings, /sendUrl[\s\S]*url\.value = ''[\s\S]*catch/);
assert.match(pluginTypes, /'singlePlay'/);
assert.match(playerManager, /case 'singlePlay'[\s\S]*return 'singlePlay'/);
assert.match(playerManager, /this\.playMode === 'singlePlay'[\s\S]*this\.currentIndex \+ 1/);
assert.match(playerManager, /Single-play completed, pausing on current song/);
assert.match(fullscreenPlayer, /<PlayerModePopup/);
assert.match(fullscreenPlayer, /<PlayerVolumePopup/);
assert.match(fullscreenPlayer, /<PlayerSleepTimerPopup/);
assert.match(fullscreenPlayer, /action: next \? 'add' : 'remove'/);
assert.match(fullscreenPlayer, /isFavorite\.value = next/);
assert.match(fullscreenPlayer, /class="player-favorite-button"/);
assert.match(fullscreenPlayer, /class="fullscreen-tool-desktop player-favorite-button"/);
assert.equal((fullscreenPlayer.match(/player-icon/g) || []).length, 12);
assert.match(slButton, /playerIcon\?: boolean/);
assert.match(slButton, /:player-icon="playerIcon"/);
assert.match(slIcon, /favorite: 0xe25b/);
assert.match(slIcon, /looks_one: 0xf19e/);
assert.match(slIcon, /uiIconCodePoints/);
assert.match(slIcon, /props\.playerIcon \? playerIconCodePoints : uiIconCodePoints/);
assert.match(slIcon, /settings: 0xe8b8/);
assert.match(slIcon, /construction: 0xea3c/);
assert.match(slIcon, /'sl-icon-ui'/);
assert.doesNotMatch(modePopup, /looks_one_outlined/);
assert.match(style, /\.player-favorite-button\.player-control-active \.sl-icon[^}]*font-variation-settings: 'FILL' 1/);
assert.match(slIcon, /String\.fromCodePoint/);
assert.match(style, /\.material-symbols-outlined\.sl-icon-material-player[^}]*font-family: 'Material Icons Player'/);
assert.match(style, /\.material-symbols-outlined\.sl-icon-ui[^}]*font-family: 'Miot UI Icons'/);
assert.match(style, /miot-ui-icons\.otf/);
assert.match(style, /\.sl-select-backdrop[^}]*position: fixed/);
assert.match(style, /material-icons-player\.otf/);
assert.match(style, /\.player-favorite-button\.player-control-active[^}]*#f44336/);
assert.match(sleepTimerPopup, /status\.active \? 'alarm_on' : 'alarm'/);
assert.match(sleepTimerPopup, /choose\('time', 15\)/);
assert.match(sleepTimerPopup, /choose\('songs', 5\)/);
assert.match(style, /\.player-sleep-popup[^}]*width: 280px[^}]*max-width: calc\(100vw - 32px\)/);
// PlayerBar 工具区弹层右对齐，防止右侧溢出视口（#388）。
// 这件事已从 CSS override 迁到 positionPopup() 里算 fixed 坐标（弹层要脱离
// .player-popup-anchor 的堆叠上下文，否则遮罩会压住弹层），所以断言落在
// 那段钳制逻辑上：工具区按 right 对齐，其余居中，两者都不许越过 edgeInset。
assert.match(sleepTimerPopup, /const isBarTools = el\.closest\('\.player-bar-tools'\) !== null/);
assert.match(sleepTimerPopup, /isBarTools\s*\n?\s*\? Math\.max\(edgeInset, rect\.right - maxWidth\)/);
assert.match(sleepTimerPopup, /window\.innerWidth - maxWidth - edgeInset/);
// 遮罩必须与弹层的 z-index 不冲突（songloft-org/songloft-plugin-miot 历史结论）。
assert.match(style, /\.player-popup-dismiss \{ position: fixed; z-index: 231; inset: 0;/);
assert.match(sleepTimerPopup, /navigation\.playerPopup = props\.popupId;\s*emit\('refresh'\)/);
assert.match(style, /\.fullscreen-stage\s*\{\s*flex: 1 1 0%/);
assert.match(style, /\.fullscreen-mobile-slide \.fullscreen-cover-frame[^}]*height: 72vw[^}]*max-height: 320px/);
assert.match(style, /\.fullscreen-layout[^}]*padding-bottom: calc\(228px \+ var\(--sl-safe-bottom/);
assert.match(style, /\.fullscreen-playback[^}]*position: fixed[^}]*bottom: var\(--sl-safe-bottom[^}]*height: 228px/);
assert.match(fullscreenPlayer, /@seek="seekPlayer"/);
assert.match(fullscreenPlayer, /class="fullscreen-desktop-stage"/);
assert.match(fullscreenPlayer, /class="fullscreen-mobile-pager"/);
assert.match(fullscreenPlayer, /currentPager\.scrollLeft = target/);
assert.match(fullscreenPlayer, /pager\.scrollLeft = pager\.clientWidth \* index/);
assert.match(fullscreenPlayer, /mobileSettledPage === 0[\s\S]*ratio >= 0\.12[\s\S]*ratio <= 0\.88/);
assert.match(fullscreenPlayer, /@scroll\.passive="syncMobilePage"/);
assert.match(fullscreenPlayer, /icon="keyboard_arrow_down"/);
assert.doesNotMatch(fullscreenPlayer, /AppBar|正在播放/);
assert.match(fullscreenPlayer, /@touchstart\.passive="startMobileSwipe"/);
assert.match(fullscreenPlayer, /@touchend="finishMobileSwipe"/);
assert.doesNotMatch(fullscreenPlayer, /scrollIntoView/);
assert.match(fullscreenPlayer, /panel\.scrollTo\(\{ top:/);
assert.match(fullscreenPlayer, /result\.lyric \|\| result\.lxlyric/);
assert.match(lyricHandler, /success: true,[\s\S]*data: \{[\s\S]*lyric:/);
assert.match(fullscreenPlayer, /showMobilePage\(1\)/);
assert.match(fullscreenPlayer, /class="fullscreen-controls fullscreen-controls-desktop"/);
assert.match(fullscreenPlayer, /class="fullscreen-controls fullscreen-controls-mobile"/);
assert.match(style, /\.fullscreen-player\s*\{[^}]*height: 100dvh[^}]*overflow: hidden/);
assert.match(style, /\.fullscreen-desktop-stage\s*\{[^}]*grid-template-columns/);
assert.match(style, /\.fullscreen-mobile-pager\s*\{[^}]*scroll-behavior: auto/);
assert.match(modePopup, /player-mode-popup/);
assert.match(volumePopup, /player-volume-popup/);
assert.match(volumePopup, /orientation="vertical"/);
assert.match(sliderComponent, /type="range"/);

// 图标字体内联进 CSS（songloft-org/songloft-plugin-miot#81），vite.config 的
// assetsInlineLimit 负责这件事。
// 滑块统一走原生 <input type="range">，读 event.target.value。
assert.match(sliderComponent, /type="range"/);
assert.match(progress, /type="range"/);
assert.match(viteConfig, /assetsInlineLimit: 16 \* 1024/);
assert.match(volumePopup, /function clampVolume\(value: number\)/);
assert.match(volumePopup, /ref\(clampVolume\(props\.modelValue\)\)/);
assert.match(progress, /player-seek-input/);
assert.match(playlistHandler, /router\.post\('\/player\/seek'/);
assert.match(playlistHandler, /router\.post\('\/player\/speed'/);
assert.match(speedPopup, /player-speed-button/);
assert.match(speedPopup, /const SPEEDS = \[0\.5, 0\.75, 1, 1\.25, 1\.5, 1\.75, 2\]/);
assert.match(fullscreenPlayer, /PlayerSpeedPopup[\s\S]*popup-id="full-speed"/);
assert.match(store, /export async function setPlaybackSpeed/);
// setVolume 不能走 playerCommand（会整体覆盖 state.player 导致音量归零 #382/#388）
assert.doesNotMatch(store, /setVolume[\s\S]*playerCommand/);
assert.match(store, /setVolume[\s\S]*await post\('\/mina\/volume'/);
assert.match(store, /setVolume[\s\S]*requestStatusRefresh/);
assert.match(playerManager, /playbackSpeed[\s\S]*getPlaybackSpeed/);
assert.match(pluginTypes, /play_speed: number/);
assert.match(pluginTypes, /speed: number;\s*\/\/ 当前播放倍速/);
assert.match(playlistHandler, /songloft\.playlists\.addSongs\(favPlaylist\.id, \[songId\]\)/);
assert.match(playlistHandler, /songloft\.playlists\.removeSongs\(favPlaylist\.id, \[songId\]\)/);
assert.match(favorites, /playlist\.id === 1/);
assert.match(voiceCommandHandler, /router\.post\('\/voice-commands\/sleep-timer'/);
assert.match(voiceEngine, /setSleepTimer\(/);
assert.match(playlistHandler, /status\.state === 'stopped'/);
assert.match(app, /MIoT/);
assert.ok(app.length > 50000, '生产 bundle 过小，可能没有包含 Vue 页面');

// 刻意不用 CSS min() / max()（历史约束，songloft-org/songloft-plugin-miot#80）：
// 一律改写成 width + max-width 这类对偶属性。
// minmax() 是 grid 轨道语法，不受影响，要排除掉。
const cssMathFunctions =
  style.replace(/\/\*[\s\S]*?\*\//g, '').match(/(?<![-\w])(?<!min)(?:min|max)\(/g) || [];
assert.deepEqual(cssMathFunctions, [], `style.css 里不允许用 CSS min()/max()：${cssMathFunctions}`);
assert.match(style, /\.qr-box img[^}]*width: 100%; max-width: 200px/);
assert.match(style, /\.toast \{[^}]*max-width: 520px/);
assert.match(style, /\.toast-host[^}]*padding: 0 16px/);

// 这两个表单容器必须用 flex 而非 grid（songloft-org/songloft-plugin-miot#79 历史结论）。
assert.match(style, /\.field-grid \{ display: flex; flex-wrap: wrap; gap: 0 16px; \}/);
assert.match(style, /\.field-grid > \* \{ flex: 1 1 calc\(50% - 8px\); min-width: 0; \}/);
assert.match(style, /\.field-grid > \* \{ flex-basis: 100%; \}/);
assert.match(style, /\.sleep-timer-custom \{ display: flex;/);
const gridClasses = [...style.matchAll(/^\.([\w-]+)[^{]*\{[^}]*display: grid/gm)].map((m) => m[1]);
assert.ok(
  !gridClasses.includes('field-grid') && !gridClasses.includes('sleep-timer-custom'),
  `表单两列容器不能退回 display:grid：${gridClasses}`,
);
// 余下的 grid 容器（纯 button/section 子项）仍受「直接子项不能是 Sl* 控件」约束（历史结论）
gridClasses.push('field-grid', 'sleep-timer-custom');
const vueSources = fs
  .readdirSync(path.join(sourceRoot, 'views'), { recursive: true })
  .filter((f) => String(f).endsWith('.vue'))
  .map((f) => [String(f), read(path.join('views', String(f)))]);
for (const [name, source] of vueSources) {
  for (const gridClass of gridClasses) {
    const offenders = source.match(
      new RegExp(`class="[^"]*\\b${gridClass}\\b[^"]*"[^>]*>\\s*<Sl[A-Za-z]+`, 'g'),
    );
    assert.equal(
      offenders,
      null,
      `views/${name}：.${gridClass} 的直接子项不能是 Sl* 控件，要包一层 div：${offenders}`,
    );
  }
}
assert.match(voiceSettings, /field-grid"><div class="field"><SlInput v-model="sourceDrafts\[source\.id\]\.name"/);
assert.match(voiceSettings, /field-grid"><div class="field"><SlInput v-model="newSourceName"/);
assert.match(style, /\.grid-cell \{ min-width: 0; \}/);
assert.match(sleepTimerPopup, /sleep-timer-custom">\s*<div class="grid-cell"><SlInput/);

// 歌单下拉统一显示歌曲数（songloft-org/songloft-plugin-miot#79 评论）
assert.match(store, /export function playlistLabel/);
assert.match(store, /\$\{playlist\.name\} \(\$\{playlist\.song_count \?\? 0\}\)/);
for (const [name, source] of [
  ['MainPage', mainPage],
  ['ScheduleSettings', scheduleSettings],
  ['VoiceSettings', voiceSettings],
]) {
  assert.match(source, /playlistLabel\(/, `${name} 的 playlistOptions 应使用 playlistLabel`);
}

// 定时任务的全局动作 enable_monitor / disable_monitor（songloft-org/songloft-plugin-miot#89）：
// executor 早就支持，但 handler 的 validateTaskParams 漏了这两个 case，全部落到 default
// 返回「未知的动作类型」，任务一个字节都存不进去。两端各有一份动作清单，都得盯：
// 后端要放行参数与设备校验，前端要隐藏目标设备区、且列表别把原始值当文案显示。
assert.match(scheduleHandler, /case 'enable_monitor':\s*case 'disable_monitor':/);
assert.match(scheduleHandler, /function isGlobalAction\(action: TaskAction\)/);
// 两处调用点（新增 / 更新）都必须跳过设备校验，否则关掉「所有受管理设备」就存不进去
assert.equal(
  (scheduleHandler.match(/if \(!isGlobalAction\(action\)\) \{\s*const targetErr/g) || []).length, 2,
  'POST /schedules 与 /schedules/update 都要对全局动作跳过 validateTaskTarget',
);
assert.match(scheduleSettings, /const globalActions = \['enable_monitor', 'disable_monitor'\]/);
assert.match(scheduleSettings, /<template v-if="!isGlobalAction">[\s\S]*?目标设备/);
assert.match(scheduleSettings, /v-if="!isGlobalAction && !allManaged"/);
assert.match(scheduleSettings, /if \(!global && !allManaged\.value/);
// 列表副标题显示中文 label，不是 enable_monitor 这种原始值
assert.match(scheduleSettings, /\{\{ actionLabel\(task\.action\) \}\}/);

// 定时播放：预设音量 & 播放时长（songloft-org/songloft#476）
// 前端：仅 play_playlist(_from) 有两个可选参数入口；stop_after_minutes 与
// voiceEngine.setSleepTimer('time') 上限 999 分钟对齐；列表副标题带上提示。
assert.match(scheduleSettings, /const presetVolumeEnabled = ref\(false\)/);
assert.match(scheduleSettings, /const stopAfterMinutes = ref\(''\)/);
assert.match(scheduleSettings, /isPlayAction && presetVolumeEnabled\.value \? \{ volume: volume\.value \}/);
assert.match(scheduleSettings, /stopMinutes > 0 \? \{ stop_after_minutes: stopMinutes \}/);
// 上限 999 与后端 setSleepTimer('time') 保持一致，不能悄悄放宽到 1440
assert.match(scheduleSettings, /stopMinutesRaw <= 999/);
assert.doesNotMatch(scheduleSettings, /stopMinutesRaw <= 1440/);
assert.match(scheduleSettings, /function taskExtras\(task: ScheduledTask\)/);
assert.match(scheduleSettings, /taskExtras\(task\)/);
assert.match(scheduleSettings, /播放前预设音量/);
assert.match(scheduleSettings, /播放时长（分钟，1-999，0 不启用）/);

// 后端 handler：两个字段都是可选的，值越界要给出中文提示
assert.match(scheduleHandler, /音量值应在 0-100 之间/);
assert.match(scheduleHandler, /播放时长应为 1-999 分钟的整数/);

// TaskExecutor：预设音量与挂表都要独立可复用（并且 stop_after_minutes 复用 SleepTimer 而非新造 setTimeout）
const executorSource = fs.readFileSync(path.join(frontendRoot, '../src/schedule/executor.ts'), 'utf8');
assert.match(executorSource, /private async applyPresetVolume\(target: DeviceTarget, params: TaskParams\)/);
assert.match(executorSource, /private async applyStopTimer\(target: DeviceTarget, params: TaskParams\)/);
assert.match(executorSource, /this\.voiceEngine\.setSleepTimer\(target\.accountId, target\.deviceId, 'time', m\)/);
// main.ts 必须把 voiceEngine 传给 TaskExecutor，否则挂表分支永远走不到
const mainSource = fs.readFileSync(path.join(frontendRoot, '../src/main.ts'), 'utf8');
assert.match(mainSource, /new TaskExecutor\([^)]*groupCoordinator, voiceEngine\)/);
// TaskParams 增加 stop_after_minutes 字段
assert.match(pluginTypes, /stop_after_minutes\?: number/);

// 歌曲删除（songloft-org/songloft#465）：用户在音箱上听到不想的歌可以直接在插件里删，
// 不必切回本地歌单模式。三处入口 + 后端一份收口 + 可选"从曲库永久删除"复选框。
// ① 后端：POST /player/song/remove 收下 playlist_id / song_id / from_library 三个参数，
//   把"从歌单去除、可选清曲库、正播那首要先切下一首"这几件事集中在一处。
assert.match(playlistHandler, /router\.post\('\/player\/song\/remove'/);
assert.match(playlistHandler, /const fromLibrary = body\.from_library === true/);
assert.match(playlistHandler, /await songloft\.playlists\.removeSongs\(playlistId, \[songId\]\)/);
assert.match(playlistHandler, /await songloft\.songs\.delete\(songId\)/);
assert.match(playlistHandler, /await manager\.next\(\)/);
assert.match(playlistHandler, /await manager\.removeSongFromMemory\(songId\)/);
// 临时歌单没有持久化记录，不能对它调 removeSongs bridge
assert.match(playlistHandler, /if \(!isTempPlaylistId\(playlistId\)\)/);
// ② PlaylistManager 内存队列同步：currentIndex 与 randomPlayed 都要跟着调整
assert.match(playerManager, /async removeSongFromMemory\(songId: number\): Promise<boolean>/);
assert.match(playerManager, /this\.songs\.splice\(idx, 1\)/);
assert.match(playerManager, /this\.clearPendingNextIndex\(\)/);
// ③ 前端 store：确认对话框现在返回 { confirmed, checked }，为的是复选框状态一起回传
assert.match(store, /export function confirmAction/);
assert.match(store, /Promise<\{ confirmed: boolean; checked: boolean \}>/);
assert.match(store, /export async function removeSongFromPlaylist/);
assert.match(store, /'\/player\/song\/remove'/);
assert.match(store, /from_library: !!opts\.fromLibrary/);
// 旧签名的 `!(await confirmAction(...))` 必须全部改成读 .confirmed，否则
// 对话框永远返回 truthy 对象，Cancel 也当成 OK
assert.doesNotMatch(scheduleSettings, /!\(await confirmAction\([^)]*\)\)\)/);
assert.doesNotMatch(voiceSettings, /!\(await confirmAction\([^)]*\)\)\)/);
// ④ ConfirmDialog 渲染可选复选框；SlCheckbox 已挂上双向绑定
const confirmDialog = read('views/ConfirmDialog.vue');
assert.match(confirmDialog, /<SlCheckbox/);
assert.match(confirmDialog, /state\.confirm\.checkbox\.checked/);
// ⑤ SongRow 支持 removable + remove 事件；样式复用现有 song-actions
assert.match(songRow, /removable\?: boolean/);
assert.match(songRow, /remove: \[Song\]/);
assert.match(songRow, /icon="delete" title="从歌单删除"/);
// ⑥ MainPage 挂 remove 处理，且临时歌单（id<=0）不亮删除按钮
assert.match(mainPage, /const songRemovable = computed/);
assert.match(mainPage, /Number\.isFinite\(id\) && id > 0/);
assert.match(mainPage, /:removable="songRemovable" @play="play" @remove="removeSong"/);
assert.match(mainPage, /同时从曲库中永久删除歌曲文件/);
// ⑦ 全屏播放器工具栏也放一个删除按钮，直接对准正播那首
assert.match(fullscreenPlayer, /removeCurrentSong/);
assert.match(fullscreenPlayer, /title="从歌单删除"/);
assert.match(fullscreenPlayer, /同时从曲库中永久删除歌曲文件/);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
assert.equal(clamp(120, 0, 100), 100);
assert.equal(clamp(-1, 0, 100), 0);
assert.equal(clamp(42, 0, 100), 42);

console.log('miot frontend contract tests passed');
