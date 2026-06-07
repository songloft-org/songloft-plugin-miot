/**
 * 应用主入口
 * 负责初始化、Tab 切换、事件绑定和模块协调
 */

// ========== Tracely 监控 SDK 配置（填写后生效） ==========

/** Tracely 监控配置，请在此填写您的 AppID、AppSecret 和 Host */
window.TRACELY_CONFIG = {
    appId: 'mimusic-xiaomi',
    appSecret: '9273893b129d5c9c423783ea512f409822c4117ab846e8908548443533022f06',
    host: 'https://mimusictracely.hanxi.cc',
};

// ========== 全局变量（当前选中的设备） ==========
window.currentAccountId = '';
window.currentDeviceId = '';

import { updateControlState, clearResult, showSnackbar } from './utils.js';
import { loadDevices, updateDeviceSelect, confirmDeviceSelection, updateCurrentDeviceCard, toggleDeviceSelectPanel, closeDeviceSelectPanel, selectDevice } from './device.js';
import { loadPlaylists, loadPlaylistSongs, playPlaylist, playUrl, highlightSongItem, togglePlaylistSelectPanel, closePlaylistSelectPanel, selectPlaylist } from './playlist.js';
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
    loadDeviceStatus,
    togglePlayPause,
    togglePlayModePanel,
    closePlayModePanel,
    selectPlayMode,
    toggleVolumePanel,
    closeVolumePanel,
    closeAllPopups,
    stopPlaylist
} from './playback.js';
import { initDialogs } from './modal.js';
import { autoFillServerHost, saveConfig, loadConfig, initConversationUI, initVoiceCommandUI, initTimezoneUI, initForceMp3UI, initExtraMusicApiModelsUI, initAIConfigUI, initExternalSearchUI, initExternalSearchSpecUI } from './config.js';
import { addAccount, addAccountWithToken, deleteAccount, toggleDeviceManagement, loadAccounts, reLoginAccount } from './account.js';
import { submitCaptcha, openVerifyUrl, submitVerifyCode, startQRCodeLogin } from './auth.js';
import { Tracely } from './tracely-sdk.js';
import { initScheduleUI, loadSchedules } from './schedule.js';
import { initIndexingUI, loadIndexStatus } from './indexing.js';

// ========== Tab 切换逻辑 ==========

/**
 * 切换 Tab 页面
 * @param {string} tabId - Tab ID: 'player', 'devices', 'settings'
 */
window.switchTab = function(tabId) {
    // 如果不是由 popstate 触发，则推入历史记录
    if (!window._isPopState) {
        history.pushState({ tab: tabId }, '', '#' + tabId);
    }
    // 切换内容区域
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-item').forEach(el => el.classList.remove('active'));

    const tabContent = document.getElementById('tab-' + tabId);
    const tabItem = document.querySelector(`.tab-item[data-tab="${tabId}"]`);

    if (tabContent) tabContent.classList.add('active');
    if (tabItem) tabItem.classList.add('active');

    // 切换 Tab 时重置滚动位置
    window.scrollTo(0, 0);

    // 设备名称仅在播放控制 Tab 显示
    const appBarDevice = document.getElementById('currentDeviceCard');
    if (appBarDevice) {
        appBarDevice.style.display = (tabId === 'player') ? 'flex' : 'none';
    }

    // 播放控制栏仅在播放控制 Tab 显示
    const playerBar = document.querySelector('.player-bar');
    if (playerBar) {
        playerBar.style.display = (tabId === 'player') ? '' : 'none';
    }

    // 歌单选择栏仅在播放控制 Tab 显示
    const playlistSelector = document.querySelector('.playlist-selector');
    if (playlistSelector) {
        playlistSelector.style.display = (tabId === 'player') ? 'flex' : 'none';
    }

    // 切换到设备管理 Tab 时加载设备列表
    if (tabId === 'devices') {
        loadDevices();
        loadAccounts();
    }

    // 切换到设置 Tab 时加载配置
    if (tabId === 'settings') {
        loadConfig();
        loadSchedules();
        loadIndexStatus();
    }
};

// ========== 将函数挂载到 window 供 HTML onclick 调用 ==========

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

// 登录验证
window.submitCaptcha = submitCaptcha;
window.openVerifyUrl = openVerifyUrl;
window.submitVerifyCode = submitVerifyCode;
window._startQRCodeLogin = startQRCodeLogin;
window._retryQRCode = startQRCodeLogin;
window._reLoginAccount = reLoginAccount;

// ========== 定时刷新播放状态 ==========

/** 播放状态定时刷新定时器 */
let playerStatusTimer = null;

/**
 * 启动播放状态定时刷新（每秒一次）
 * 切换设备时调用此函数重置定时器
 */
export function startPlayerStatusPolling() {
    if (playerStatusTimer) {
        clearInterval(playerStatusTimer);
    }
    playerStatusTimer = setInterval(() => {
        loadDeviceStatus();
    }, 1000);
}

/**
 * 停止播放状态定时刷新
 */
export function stopPlayerStatusPolling() {
    if (playerStatusTimer) {
        clearInterval(playerStatusTimer);
        playerStatusTimer = null;
    }
}

// ========== 初始化 ==========

document.addEventListener('DOMContentLoaded', () => {
    // 设置初始历史状态（使用 replaceState 避免多余条目）
    history.replaceState({ tab: 'player' }, '', '#player');

    // 监听浏览器返回/前进，恢复对应 Tab
    window.addEventListener('popstate', (event) => {
        if (event.state && event.state.tab) {
            window._isPopState = true;
            window.switchTab(event.state.tab);
            window._isPopState = false;
        }
    });

    // 初始化 Tracely 监控 SDK
    if (window.TRACELY_CONFIG.appId && window.TRACELY_CONFIG.appSecret && window.TRACELY_CONFIG.host) {
        window.tracely = new Tracely(window.TRACELY_CONFIG);
        window.tracely.init();
    }

    // 初始化 Dialog 事件监听
    initDialogs();

    // 初始化播放模式按钮为默认值
    const defaultMode = playModes.find(m => m.value === 'loop');
    if (defaultMode) {
        updatePlayModeButton('loop', defaultMode.label, defaultMode.icon);
    }

    // ========== Tab Bar 事件绑定 ==========
    document.querySelectorAll('.tab-item').forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;
            if (tabId) window.switchTab(tabId);
        });
    });

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
        playBtn.addEventListener('click', () => {
            const icon = playBtn.querySelector('.material-symbols-outlined');
            if (icon && icon.textContent === 'pause') {
                stopPlaylist();
            } else {
                playPlaylist();
            }
        });
    }

    const prevBtn = document.getElementById('prevBtn');
    if (prevBtn) {
        prevBtn.addEventListener('click', previousSong);
    }

    const nextBtn = document.getElementById('nextBtn');
    if (nextBtn) {
        nextBtn.addEventListener('click', nextSong);
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

    // 初始化音频格式开关 UI
    initForceMp3UI();

    // 初始化自定义 Music API 型号 UI
    initExtraMusicApiModelsUI();

    // 初始化外部搜索配置 UI
    initExternalSearchUI();

    // 初始化外部搜索接口规范链接
    initExternalSearchSpecUI();

    // 初始化对话监听 UI
    initConversationUI();

    // 初始化索引管理 UI
    initIndexingUI();

    // 初始化语音口令 UI
    initVoiceCommandUI();

    // 初始化 AI 配置 UI
    initAIConfigUI();

    // 初始化定时任务 UI
    initScheduleUI();

    // 初始化时区设置 UI
    initTimezoneUI();

    // 初始化控制状态
    updateControlState();
});
