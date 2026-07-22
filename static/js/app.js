/**
 * 应用主入口
 * 负责初始化、Tab 切换、事件绑定和模块协调
 */

// ========== Tracely 监控 SDK 配置（填写后生效） ==========

/** Tracely 监控配置，请在此填写您的 AppID、AppSecret 和 Host */
window.TRACELY_CONFIG = {
    appId: '',
    appSecret: '',
    host: '',
};

const PLUGIN_VERSION = '2026.6.9';

// ========== 全局变量（当前选中的设备） ==========
window.currentAccountId = '';
window.currentDeviceId = '';

import { updateControlState, clearResult, showSnackbar } from './utils.js';
import { loadDevices, updateDeviceSelect, confirmDeviceSelection, updateCurrentDeviceCard, toggleDeviceSelectPanel, closeDeviceSelectPanel, selectDevice } from './device.js';
import { loadPlaylists, loadPlaylistSongs, playPlaylist, playUrl, playTTS, highlightSongItem, togglePlaylistSelectPanel, closePlaylistSelectPanel, selectPlaylist } from './playlist.js';
import {
    playModes,
    previousSong,
    nextSong,
    togglePlayMode,
    updatePlayModeButton,
    autoSetVolume,
    initializePlaybackControls,
    toggleMute,
    updateVolumeIcon,
    getPlayerStatus,
    togglePlayPause,
    togglePlayModePanel,
    closePlayModePanel,
    selectPlayMode,
    toggleVolumePanel,
    closeVolumePanel,
    closeAllPopups,
    stopPlaylist
} from './playback.js';
import { connectStatusStream, disconnectStatusStream } from './status-stream.js';
import { initDialogs } from './modal.js';
import { autoFillServerHost, saveConfig, loadConfig, initServerHostUI, initPollIntervalUI, initConversationPollDebugUI, initSmartResumeUI, initMaxSongIndexUI, initConversationUI, initVoiceCommandUI, initVoiceMemoryUI, initTimezoneUI, initForceMp3UI, initIndicatorLightUI, initTouchscreenLyricsUI, initExtraMusicApiModelsUI, initAIConfigUI, initExternalSearchUI, initExternalSearchSpecUI, initInterruptBroadcastUI, initDefaultCoverUI, loadConversationStatus } from './config.js';
import { addAccount, addAccountWithToken, deleteAccount, toggleDeviceManagement, loadAccounts, reLoginAccount } from './account.js';
import { submitCaptcha, openVerifyUrl, submitVerifyCode, startQRCodeLogin } from './auth.js';
import { Tracely } from './tracely-sdk.js';
import { initScheduleUI, loadSchedules } from './schedule.js';
import { initIndexingUI, loadIndexStatus } from './indexing.js';
import { initFullscreenPlayer, openFullscreenPlayer, closeFullscreenPlayer } from './fullscreen-player.js';

// ========== 页面导航逻辑 ==========

/** 当前活动页面 */
let currentPage = 'player';

/**
 * 导航到子页面
 * @param {string} pageId - 'settings'，兼容旧的 'devices' 账号管理入口
 */
window.navigateTo = function(pageId) {
    const openAccountManagement = pageId === 'devices';
    const targetPage = openAccountManagement ? 'settings' : pageId;

    if (currentPage === targetPage) {
        if (openAccountManagement) openAccountManagementSettings();
        return;
    }

    history.pushState({ page: targetPage, accountManagement: openAccountManagement }, '', '#' + targetPage);
    showPage(targetPage, { openAccountManagement });
};

/**
 * 返回上一页
 */
window.navigateBack = function() {
    history.back();
};

/**
 * 显示指定页面，更新 AppBar 状态
 * @param {string} pageId - 'player' 或 'settings'，兼容旧的 'devices'
 * @param {{ openAccountManagement?: boolean }} [options]
 */
function showPage(pageId, options = {}) {
    const openAccountManagement = options.openAccountManagement || pageId === 'devices';
    if (pageId === 'devices') pageId = 'settings';

    currentPage = pageId;

    document.querySelectorAll('.page-content').forEach(el => el.classList.remove('active'));
    const pageContent = document.getElementById('tab-' + pageId);
    if (pageContent) pageContent.classList.add('active');

    window.scrollTo(0, 0);

    const isMain = pageId === 'player';

    // AppBar 状态切换
    const navBackBtn = document.getElementById('navBackBtn');
    const appBarIcon = document.getElementById('appBarIcon');
    const appBarTitle = document.getElementById('appBarTitle');
    const settingsBtn = document.getElementById('settingsBtn');

    if (navBackBtn) navBackBtn.style.display = isMain ? 'none' : '';
    if (appBarIcon) appBarIcon.style.display = isMain ? '' : 'none';
    if (appBarTitle) appBarTitle.textContent = isMain ? 'MIoT 智能音箱' : '设置';
    if (settingsBtn) settingsBtn.style.display = isMain ? '' : 'none';

    // 工具栏 + 播放栏仅播放页可见
    const playerToolbar = document.getElementById('playerToolbar');
    if (playerToolbar) playerToolbar.style.display = isMain ? 'flex' : 'none';

    const playerBar = document.querySelector('.player-bar');
    if (playerBar) playerBar.style.display = isMain ? '' : 'none';

    // 子页面数据加载
    if (pageId === 'settings') {
        loadConfig();
        loadSchedules();
        loadIndexStatus();
        loadAccounts();
        initSettingsMasterDetail();
        const layout = document.getElementById('settingsLayout');
        if (layout) layout.classList.remove('view-detail');
        // 列表态（含宽屏双栏）：顶部返回按钮保留，用于退出设置页回到播放页
        settingsInDetail = false;
        if (openAccountManagement) openAccountManagementSettings();
    }
}

// ========== 设置页 Master/Detail（对齐主程序设置页响应式范式） ==========
const SETTINGS_CATEGORIES = [
    { id: 'device',   icon: 'router',            title: '设备与连接',   subtitle: '服务器、账号、指示灯、自定义型号' },
    { id: 'playback', icon: 'lyrics',            title: '播放与显示',   subtitle: '音频格式、触屏歌词、默认封面' },
    { id: 'voice',    icon: 'record_voice_over', title: '语音交互',     subtitle: '对话监听、口令、记忆、外部搜索' },
    { id: 'schedule', icon: 'schedule',          title: '定时与自动化', subtitle: '时区、定时任务' },
    { id: 'toolbox',  icon: 'build',             title: '工具箱',       subtitle: 'URL 播放、文字播报、操作结果' },
];
let settingsNavBuilt = false;
let settingsSelectedCategory = 'device';
let settingsInDetail = false;  // 手机端：是否处于「分类详情」视图（决定顶部返回行为）

function buildSettingsNav() {
    const nav = document.getElementById('settingsNav');
    if (!nav) return;
    nav.innerHTML = '';
    SETTINGS_CATEGORIES.forEach(cat => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'settings-nav-item';
        btn.dataset.category = cat.id;
        btn.setAttribute('aria-label', cat.title);
        btn.innerHTML =
            '<span class="settings-nav-icon"><span class="material-symbols-outlined">' + cat.icon + '</span></span>' +
            '<span class="settings-nav-text">' +
                '<span class="settings-nav-title">' + cat.title + '</span>' +
                '<span class="settings-nav-subtitle">' + cat.subtitle + '</span>' +
            '</span>' +
            '<span class="material-symbols-outlined settings-nav-chevron">chevron_right</span>';
        btn.addEventListener('click', () => {
            selectSettingsCategory(cat.id);
            const layout = document.getElementById('settingsLayout');
            const isNarrow = window.matchMedia('(max-width: 599px)').matches;
            // 手机端进入分类详情：顶部返回按钮改为「回到分类列表」，标题显示分类名
            if (layout && isNarrow) {
                layout.classList.add('view-detail');
                settingsInDetail = true;
                const navBackBtn = document.getElementById('navBackBtn');
                if (navBackBtn) navBackBtn.style.display = '';
                const appBarTitle = document.getElementById('appBarTitle');
                if (appBarTitle) appBarTitle.textContent = cat.title;
            }
        });
        nav.appendChild(btn);
    });
    settingsNavBuilt = true;
}

function selectSettingsCategory(id) {
    settingsSelectedCategory = id;
    document.querySelectorAll('#settingsNav .settings-nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.category === id);
    });
    document.querySelectorAll('#tab-settings .card[data-category]').forEach(card => {
        card.style.display = card.dataset.category === id ? '' : 'none';
    });
}

function initSettingsMasterDetail() {
    if (!settingsNavBuilt) buildSettingsNav();
    selectSettingsCategory(settingsSelectedCategory);
}

// 兼容旧账号管理入口：进入设置的设备分类并定位到账号管理区域
function openAccountManagementSettings() {
    selectSettingsCategory('device');

    const layout = document.getElementById('settingsLayout');
    if (layout && window.matchMedia('(max-width: 599px)').matches) {
        layout.classList.add('view-detail');
        settingsInDetail = true;

        const navBackBtn = document.getElementById('navBackBtn');
        if (navBackBtn) navBackBtn.style.display = '';

        const appBarTitle = document.getElementById('appBarTitle');
        if (appBarTitle) appBarTitle.textContent = '设备与连接';
    }

    requestAnimationFrame(() => {
        const section = document.getElementById('accountManagementSection');
        if (section) section.scrollIntoView({ block: 'start' });
    });
}

// 回到分类列表（手机端详情态的返回目标）
function exitSettingsDetail() {
    const layout = document.getElementById('settingsLayout');
    if (layout) layout.classList.remove('view-detail');
    settingsInDetail = false;
    // 返回列表后仍保留顶部返回按钮（用于退出设置页），标题恢复为「设置」
    const appBarTitle = document.getElementById('appBarTitle');
    if (appBarTitle) appBarTitle.textContent = '设置';
}

// 顶部返回按钮：设置页详情态回到列表，其余情况走应用级返回
function onNavBack() {
    if (currentPage === 'settings' && settingsInDetail) {
        exitSettingsDetail();
        return;
    }
    navigateBack();
}

// ========== 将函数挂载到 window 供 HTML onclick 调用 ==========

// 页面导航
window.navigateTo = window.navigateTo;
window.navigateBack = window.navigateBack;

// 设备管理
window.loadDevices = loadDevices;
window.confirmDeviceSelection = confirmDeviceSelection;
window.toggleDeviceSelectPanel = toggleDeviceSelectPanel;
window.closeDeviceSelectPanel = closeDeviceSelectPanel;
window.selectDevice = selectDevice;

// 播放控制
window.playPlaylist = playPlaylist;
window.previousSong = previousSong;
window.nextSong = nextSong;
window.togglePlayMode = togglePlayMode;
window.loadPlaylists = loadPlaylists;
window.toggleMute = toggleMute;
window.togglePlayPause = togglePlayPause;

// 弹出层控制
window.togglePlayModePanel = togglePlayModePanel;
window.closePlayModePanel = closePlayModePanel;
window.selectPlayMode = selectPlayMode;
window.toggleVolumePanel = toggleVolumePanel;
window.closeVolumePanel = closeVolumePanel;
window.closeAllPopups = closeAllPopups;
window.togglePlaylistSelectPanel = togglePlaylistSelectPanel;
window.closePlaylistSelectPanel = closePlaylistSelectPanel;

// 全屏播放器
window.openFullscreenPlayer = openFullscreenPlayer;
window.closeFullscreenPlayer = closeFullscreenPlayer;

// URL 播放
window.playUrl = playUrl;

// 操作结果
window.clearResult = clearResult;

// 设置
window.autoFillServerHost = autoFillServerHost;
window.saveConfig = saveConfig;

// 账号管理
window.addAccount = addAccount;
window.addAccountWithToken = addAccountWithToken;
window._deleteAccount = deleteAccount;
window._toggleDeviceManagement = toggleDeviceManagement;
// 供设备勾选后刷新「对话监听」设备列表展示（后端已在 /mina/device/managed 内同步 refresh，前端仅需重拉状态）
window._refreshConversationStatus = loadConversationStatus;

// 登录验证
window.submitCaptcha = submitCaptcha;
window.openVerifyUrl = openVerifyUrl;
window.submitVerifyCode = submitVerifyCode;
window._startQRCodeLogin = startQRCodeLogin;
window._retryQRCode = startQRCodeLogin;
window._reLoginAccount = reLoginAccount;

// ========== 实时刷新播放状态 ==========
//
// 优先用 WebSocket 订阅后端状态推送；WS 不可用时 status-stream.js 内部自动降级为
// 每秒轮询 loadDeviceStatus()。函数名保持不变，device.js 切换设备时仍调用它重连。

/**
 * 启动播放状态实时刷新（WebSocket 优先，失败降级轮询）。
 * 切换设备时调用此函数按新设备重连。
 */
export function startPlayerStatusPolling() {
    connectStatusStream(window.currentAccountId || '', window.currentDeviceId || '');
}

/**
 * 停止播放状态实时刷新（断开 WS 并停止兜底轮询）。
 */
export function stopPlayerStatusPolling() {
    disconnectStatusStream();
}

// ========== 初始化 ==========

document.addEventListener('DOMContentLoaded', () => {
    // 设置初始历史状态
    history.replaceState({ page: 'player' }, '', '#player');

    // 监听浏览器返回/前进
    window.addEventListener('popstate', (event) => {
        const page = event.state?.page || event.state?.tab || 'player';
        showPage(page, {
            openAccountManagement: page === 'devices' || event.state?.accountManagement === true,
        });
    });

    // 初始化 Tracely 监控 SDK
    if (window.TRACELY_CONFIG.appId && window.TRACELY_CONFIG.appSecret && window.TRACELY_CONFIG.host) {
        window.tracely = new Tracely(window.TRACELY_CONFIG);
        window.tracely.init();

        // 上报安装或升级事件
        const lastVersion = localStorage.getItem('miot_tracely_version');
        if (!lastVersion) {
            window.tracely.reportInstall(PLUGIN_VERSION, 'web');
        } else if (lastVersion !== PLUGIN_VERSION) {
            window.tracely.reportUpgrade(lastVersion, PLUGIN_VERSION, 'web');
        }
        if (lastVersion !== PLUGIN_VERSION) {
            localStorage.setItem('miot_tracely_version', PLUGIN_VERSION);
        }
    }

    // 初始化 Dialog 事件监听
    initDialogs();

    // 初始化播放模式按钮为默认值
    const defaultMode = playModes.find(m => m.value === 'loop');
    if (defaultMode) {
        updatePlayModeButton('loop', defaultMode.label, defaultMode.icon);
    }

    // ========== 导航按钮事件绑定 ==========
    const navBackBtn = document.getElementById('navBackBtn');
    if (navBackBtn) {
        navBackBtn.addEventListener('click', onNavBack);
    }

    // 旋转/缩放跨断点时，退出设置详情态，避免宽屏残留顶部返回按钮
    window.addEventListener('resize', () => {
        if (currentPage === 'settings' && window.matchMedia('(min-width: 600px)').matches) {
            exitSettingsDetail();
        }
    });

    const settingsNavBtn = document.getElementById('settingsBtn');
    if (settingsNavBtn) {
        settingsNavBtn.addEventListener('click', () => navigateTo('settings'));
    }

    // ========== Auth 子 Tab 切换 ==========
    document.querySelectorAll('.auth-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const authTab = btn.dataset.authTab;
            if (!authTab) return;

            // 切换按钮激活状态
            document.querySelectorAll('.auth-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // 切换内容区域
            document.querySelectorAll('.auth-tab-content').forEach(c => c.classList.remove('active'));
            const content = document.getElementById('auth-tab-' + authTab);
            if (content) content.classList.add('active');
        });
    });

    // ========== AppBar 刷新按钮 ==========
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            loadDevices(true);
            loadPlaylists();
            // 同时刷新歌曲/歌单索引
            SongloftPlugin.apiPost('/indexing/refresh', {}).catch(() => {});
            showSnackbar('正在刷新...', 'info');
        });
    }

    // ========== 音量控制（弹出层内） ==========
    const volumeSlider = document.getElementById('volumeSlider');
    if (volumeSlider) {
        volumeSlider.addEventListener('input', function() {
            const volumePercent = document.getElementById('volumePercent');
            if (volumePercent) volumePercent.textContent = this.value + '%';
            updateVolumeIcon(parseInt(this.value));
        });
        volumeSlider.addEventListener('change', function() {
            autoSetVolume();
        });
    }

    const muteBtn = document.getElementById('muteBtn');
    if (muteBtn) {
        muteBtn.addEventListener('click', toggleMute);
    }

    // 音量弹出按钮
    const volumePopupBtn = document.getElementById('volumePopupBtn');
    if (volumePopupBtn) {
        volumePopupBtn.addEventListener('click', toggleVolumePanel);
    }

    // ========== 设备选择（隐藏的 select 元素） ==========
    const accountSelect = document.getElementById('accountSelect');
    if (accountSelect) {
        accountSelect.addEventListener('change', function() {
            updateDeviceSelect(this.value, false);
        });
    }

    // ========== 播放控制按钮 ==========
    const playBtn = document.getElementById('playBtn');
    if (playBtn) {
        playBtn.addEventListener('click', togglePlayPause);
    }

    const prevBtn = document.getElementById('prevBtn');
    if (prevBtn) {
        prevBtn.addEventListener('click', previousSong);
    }

    const nextBtn = document.getElementById('nextBtn');
    if (nextBtn) {
        nextBtn.addEventListener('click', nextSong);
    }

    const stopBtn = document.getElementById('stopBtn');
    if (stopBtn) {
        stopBtn.addEventListener('click', stopPlaylist);
    }

    const playModeBtn = document.getElementById('playModeBtn');
    if (playModeBtn) {
        playModeBtn.addEventListener('click', togglePlayModePanel);
    }

    // ========== 账号登录 ==========
    const addAccountBtn = document.getElementById('addAccountBtn');
    if (addAccountBtn) {
        addAccountBtn.addEventListener('click', addAccount);
    }

    const addTokenBtn = document.getElementById('addTokenBtn');
    if (addTokenBtn) {
        addTokenBtn.addEventListener('click', addAccountWithToken);
    }

    const submitCaptchaBtn = document.getElementById('submitCaptchaBtn');
    if (submitCaptchaBtn) {
        submitCaptchaBtn.addEventListener('click', submitCaptcha);
    }

    const openVerifyBtn = document.getElementById('openVerifyBtn');
    if (openVerifyBtn) {
        openVerifyBtn.addEventListener('click', openVerifyUrl);
    }

    const submitVerifyBtn = document.getElementById('submitVerifyBtn');
    if (submitVerifyBtn) {
        submitVerifyBtn.addEventListener('click', submitVerifyCode);
    }

    // 扫码登录
    const getQRCodeBtn = document.getElementById('getQRCodeBtn');
    if (getQRCodeBtn) {
        getQRCodeBtn.addEventListener('click', () => {
            startQRCodeLogin();
        });
    }

    // ========== 设置页面 ==========
    const autoFillBtn = document.getElementById('autoFillBtn');
    if (autoFillBtn) {
        autoFillBtn.addEventListener('click', autoFillServerHost);
    }

    const saveConfigBtn = document.getElementById('saveConfigBtn');
    if (saveConfigBtn) {
        saveConfigBtn.addEventListener('click', saveConfig);
    }

    const playUrlBtn = document.getElementById('playUrlBtn');
    if (playUrlBtn) {
        playUrlBtn.addEventListener('click', playUrl);
    }

    const ttsBtn = document.getElementById('ttsBtn');
    if (ttsBtn) {
        ttsBtn.addEventListener('click', playTTS);
    }
    const ttsInput = document.getElementById('ttsInput');
    if (ttsInput) {
        ttsInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') playTTS();
        });
    }

    const clearResultBtn = document.getElementById('clearResultBtn');
    if (clearResultBtn) {
        clearResultBtn.addEventListener('click', clearResult);
    }

    // ========== 初始化数据加载 ==========

    /** 标记是否已完成首次歌单/歌曲初始化 */
    let playlistInitialized = false;

    // 加载歌单列表（保存 Promise 以便后续等待）
    const playlistsPromise = loadPlaylists();

    // 加载设备列表和播放状态
    loadDevices(true).then(() => {
        // 设备列表加载完成后，获取播放状态并恢复上次的设备选择
        getPlayerStatus().then(statusData => {
            // 首次初始化：根据播放状态设置歌单和歌曲选择
            if (!playlistInitialized && statusData && statusData.success && statusData.data) {
                playlistInitialized = true;
                const status = statusData.data;
                const playlistId = status.playlist_id;
                const currentIndex = status.current_index;

                if (playlistId) {
                    // 等待歌单列表加载完成后设置选中项
                    playlistsPromise.then(() => {
                        const playlistSelect = document.getElementById('playlistSelect');
                        if (playlistSelect) {
                            playlistSelect.value = String(playlistId);

                            // 更新歌单选择栏显示文本
                            const selectedOption = playlistSelect.options[playlistSelect.selectedIndex];
                            const selectorText = document.getElementById('playlistSelectorText');
                            if (selectedOption && selectedOption.value && selectorText) {
                                selectorText.textContent = selectedOption.textContent;
                            }

                            // 高亮弹出面板中的选中项
                            document.querySelectorAll('.playlist-select-item').forEach(el => {
                                el.classList.toggle('active', el.getAttribute('data-id') == playlistId);
                            });

                            // 加载该歌单的歌曲列表，完成后高亮当前播放歌曲
                            loadPlaylistSongs(String(playlistId)).then(() => {
                                if (currentIndex !== undefined && currentIndex >= 0) {
                                    highlightSongItem(currentIndex);
                                }
                            });
                        }
                    });
                } else if (currentIndex !== undefined && currentIndex >= 0) {
                    // 没有 playlist_id，仅根据 current_index 高亮歌曲
                    playlistsPromise.then(() => {
                        highlightSongItem(currentIndex);
                    });
                }
            }
        }).catch(error => {
            console.warn('获取播放状态失败，使用默认设备选择', error);
        }).finally(() => {
            // 若有选中设备则启动轮询
            if (window.currentDeviceId) {
                startPlayerStatusPolling();
            }
        });
    }).catch(error => {
        console.error('加载设备列表失败', error);
    });

    // 初始化服务器地址下拉选择 UI
    initServerHostUI();

    // 初始化可配置数值参数 UI
    initPollIntervalUI();
    initConversationPollDebugUI();
    initSmartResumeUI();
    initMaxSongIndexUI();

    // 初始化音频格式开关 UI
    initForceMp3UI();

    // 初始化指示灯开关 UI
    initIndicatorLightUI();

    // 初始化触屏歌词开关 UI
    initTouchscreenLyricsUI();

    // 初始化触屏版默认封面 UI
    initDefaultCoverUI();

    // 初始化自定义 Music API 型号 UI
    initExtraMusicApiModelsUI();

    // 初始化外部搜索配置 UI
    initExternalSearchUI();

    // 初始化外部搜索接口规范链接
    initExternalSearchSpecUI();

    // 初始化搜索提示 TTS UI
    initInterruptBroadcastUI();

    // 初始化对话监听 UI
    initConversationUI();

    // 初始化索引管理 UI
    initIndexingUI();

    // 初始化语音口令 UI
    initVoiceCommandUI();

    // 初始化语音记忆 UI
    initVoiceMemoryUI();

    // 初始化 AI 配置 UI
    initAIConfigUI();

    // 初始化定时任务 UI
    initScheduleUI();

    // 初始化时区设置 UI
    initTimezoneUI();

    // 初始化全屏播放器
    initFullscreenPlayer();

    // 初始化控制状态
    updateControlState();
});
