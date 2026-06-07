/**
 * 登录验证流程模块
 * 负责处理登录结果、验证码、二次验证等流程
 */

const { apiPost } = SongloftPlugin;
import { showSnackbar, escapeHtml } from './utils.js';
import { loadAccounts } from './account.js';

/** 登录会话 ID */
let sessionId = '';

/** 二次验证 URL */
let verifyUrl = '';

/**
 * 处理登录结果
 * 根据登录状态处理验证码或二次验证
 * @param {Object} data - 登录响应数据
 */
export function handleLoginResult(data) {
    const captchaContainer = document.getElementById('captchaContainer');
    const verifyContainer = document.getElementById('verifyContainer');

    // 先隐藏所有验证容器
    if (captchaContainer) captchaContainer.style.display = 'none';
    if (verifyContainer) verifyContainer.style.display = 'none';

    if (data.success && data.state === 0) {
        showSnackbar('登录成功', 'success');
        loadAccounts();

        // 清空输入框
        const usernameInput = document.getElementById('username');
        const passwordInput = document.getElementById('password');
        if (usernameInput) usernameInput.value = '';
        if (passwordInput) passwordInput.value = '';
        return;
    }

    switch (data.state) {
        case 1:
            // 需要图形验证码
            sessionId = data.session_id;
            const captchaImage = document.getElementById('captchaImage');
            if (captchaImage) {
                captchaImage.src = 'data:image/png;base64,' + data.captcha_image;
            }
            if (captchaContainer) {
                captchaContainer.style.display = 'block';
            }
            showSnackbar('请输入图形验证码', 'info');
            break;

        case 2:
            // 需要二次验证
            sessionId = data.session_id;
            verifyUrl = data.verify_url;
            if (verifyContainer) {
                verifyContainer.style.display = 'block';
            }
            showSnackbar('请完成二次验证', 'info');
            break;

        default:
            showSnackbar('登录失败：' + (data.message || data.error || '未知错误'), 'error');
            break;
    }
}

/**
 * 提交图形验证码
 */
export function submitCaptcha() {
    const captchaInput = document.getElementById('captchaInput');
    const captcha = captchaInput ? captchaInput.value.trim() : '';

    if (!captcha) {
        showSnackbar('请输入验证码', 'error');
        return;
    }

    apiPost('/auth/captcha', { session_id: sessionId, captcha: captcha })
        .then(handleLoginResult)
        .catch(error => {
            showSnackbar('提交失败：' + error.message, 'error');
        });
}

/**
 * 打开验证页面
 */
export function openVerifyUrl() {
    if (verifyUrl) {
        window.open(verifyUrl, '_blank');
        showSnackbar('请在新窗口中完成验证', 'info');
    } else {
        showSnackbar('验证链接不可用', 'error');
    }
}

/**
 * 提交二次验证码
 */
export function submitVerifyCode() {
    const verifyCodeInput = document.getElementById('verifyCodeInput');
    const verifyCode = verifyCodeInput ? verifyCodeInput.value.trim() : '';

    if (!verifyCode) {
        showSnackbar('请输入验证码', 'error');
        return;
    }

    apiPost('/auth/verify', { session_id: sessionId, verify_code: verifyCode })
        .then(handleLoginResult)
        .catch(error => {
            showSnackbar('提交失败：' + error.message, 'error');
        });
}

/** 扫码轮询定时器 */
let qrcodePollTimer = null;

/** 扫码登录是否已成功（防止重复处理） */
let qrcodeLoginDone = false;

/**
 * 发起扫码登录
 * 扫码成功后自动用小米 userId 创建账号，无需传入 accountId
 */
export function startQRCodeLogin() {
    // 停止之前的轮询
    stopQRCodePolling();
    qrcodeLoginDone = false;

    const qrcodeContainer = document.getElementById('qrcodeContainer');
    const qrcodeImage = document.getElementById('qrcodeImage');
    const qrcodeStatus = document.getElementById('qrcodeStatus');
    const qrcodeLoginLink = document.getElementById('qrcodeLoginLink');
    const getQRCodeBtn = document.getElementById('getQRCodeBtn');

    // 更新 UI 状态
    if (getQRCodeBtn) {
        getQRCodeBtn.disabled = true;
        getQRCodeBtn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px"></span> 获取中...';
    }

    apiPost('/auth/qrcode', {})
        .then(data => {
            if (getQRCodeBtn) {
                getQRCodeBtn.disabled = false;
                getQRCodeBtn.innerHTML = '<span class="material-symbols-outlined">qr_code_2</span> 获取二维码';
            }

            if (data.success) {
                // 显示二维码
                if (qrcodeImage) qrcodeImage.src = data.qrcode_url;
                if (qrcodeContainer) qrcodeContainer.style.display = 'block';
                if (qrcodeStatus) {
                    qrcodeStatus.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;vertical-align:middle"></span> 请使用米家APP扫描二维码';
                    qrcodeStatus.style.color = 'var(--md-on-surface-variant)';
                }
                // 显示登录链接
                if (qrcodeLoginLink && data.login_url) {
                    qrcodeLoginLink.innerHTML = '<a href="' + escapeHtml(data.login_url) + '" target="_blank" style="font-size:13px;color:var(--md-primary);text-decoration:none">或点击此链接在浏览器中登录</a>';
                }

                // 开始轮询
                pollQRCodeStatus(data.account_id);
            } else {
                showSnackbar('获取二维码失败：' + (data.message || data.error || '未知错误'), 'error');
            }
        })
        .catch(error => {
            if (getQRCodeBtn) {
                getQRCodeBtn.disabled = false;
                getQRCodeBtn.innerHTML = '<span class="material-symbols-outlined">qr_code_2</span> 获取二维码';
            }
            showSnackbar('获取二维码失败：' + error.message, 'error');
        });
}

/**
 * 轮询扫码状态（顺序轮询，前一个请求完成后再发下一个）
 * @param {string} pollSessionId - 会话 ID
 */
export function pollQRCodeStatus(pollSessionId) {
    stopQRCodePolling();

    function pollOnce() {
        if (qrcodeLoginDone) return;

        apiPost('/auth/qrcode/poll', { account_id: pollSessionId })
            .then(data => {
                if (qrcodeLoginDone) return; // 已成功，忽略后续响应

                const qrcodeStatus = document.getElementById('qrcodeStatus');

                // 防御性检查：如果后端返回 success: false（通常是异常被捕获），
                // 不应进入 default 分支继续轮询，而是作为错误处理
                if (data.success === false) {
                    stopQRCodePolling();
                    if (qrcodeStatus) {
                        qrcodeStatus.textContent = '扫码失败：' + (data.error || data.message || '未知错误');
                        qrcodeStatus.style.color = 'var(--md-error)';
                    }
                    showSnackbar('扫码登录失败：' + (data.error || data.message || '未知错误'), 'error');
                    return;
                }

                switch (data.state) {
                    case 'success':
                        qrcodeLoginDone = true;
                        stopQRCodePolling();
                        if (qrcodeStatus) {
                            qrcodeStatus.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;vertical-align:middle;color:var(--md-success)">check_circle</span> 扫码登录成功';
                            qrcodeStatus.style.color = 'var(--md-success)';
                        }
                        showSnackbar('扫码登录成功', 'success');
                        loadAccounts();
                        break;

                    case 'timeout':
                    case 'expired':
                        stopQRCodePolling();
                        if (qrcodeStatus) {
                            qrcodeStatus.innerHTML = '二维码已过期 <button class="btn-text" style="font-size:13px;padding:4px 8px" onclick="window._retryQRCode()"><span class="material-symbols-outlined" style="font-size:16px">refresh</span> 重新获取</button>';
                            qrcodeStatus.style.color = 'var(--md-warning)';
                        }
                        showSnackbar('二维码已过期，请重新获取', 'warning');
                        break;

                    case 'error':
                        stopQRCodePolling();
                        if (qrcodeStatus) {
                            qrcodeStatus.textContent = '扫码失败：' + (data.message || '未知错误');
                            qrcodeStatus.style.color = 'var(--md-error)';
                        }
                        showSnackbar('扫码登录失败：' + (data.message || '未知错误'), 'error');
                        break;

                    case 'waiting':
                    default:
                        // 等待 3 秒后再发下一次请求（顺序轮询，避免请求积压）
                        qrcodePollTimer = setTimeout(pollOnce, 3000);
                        break;
                }
            })
            .catch(error => {
                if (qrcodeLoginDone) return;
                stopQRCodePolling();
                const qrcodeStatus = document.getElementById('qrcodeStatus');
                if (qrcodeStatus) {
                    qrcodeStatus.textContent = '轮询失败：' + error.message;
                    qrcodeStatus.style.color = 'var(--md-error)';
                }
            });
    }

    // 立即发起第一次轮询
    pollOnce();
}

/**
 * 停止扫码轮询
 */
function stopQRCodePolling() {
    if (qrcodePollTimer) {
        clearTimeout(qrcodePollTimer);
        qrcodePollTimer = null;
    }
}
