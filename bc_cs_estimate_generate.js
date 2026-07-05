/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 *
 * Script 1.0 (part B) — client handler for the Generate button.
 * Calls the Suitelet that performs the server-side record creation,
 * shows the result, and reloads the Estimate.
 */
define(['N/url', 'N/https', 'N/currentRecord'], function (url, https, currentRecord) {

  var SUITELET_SCRIPT_ID = 'customscript_bc_sl_generate_proj_so';
  var SUITELET_DEPLOYMENT_ID = 'customdeploy_bc_sl_generate_proj_so';
  var ESTIMATE_TYPE_FIELD = 'custbody_bc_estimate_type';
  var ESTIMATE_TYPE_ROLLOUT = '2';
  var projectProgressRefreshTimer = null;
  var generationModalDismissed = false;

  function pageInit() {
    exposeClientFunctions();
    showStoredGenerationIssueBanner();
  }

  // Global so the button (functionName) can find it.
  function bcGenerateProjectAndSO() {
    var rec = currentRecord.get();
    var estId = rec.id;
    var estimateType = String(rec.getValue({ fieldId: ESTIMATE_TYPE_FIELD }) || '');
    generationModalDismissed = false;
    clearLastGenerationResult();
    hideGenerateButton();

    var suiteletUrl = url.resolveScript({
      scriptId: SUITELET_SCRIPT_ID,
      deploymentId: SUITELET_DEPLOYMENT_ID,
      params: {
        estid: estId,
        format: 'json'
      }
    });

    showGenerationRunning(estimateType);

    window.setTimeout(function () {
      runGenerationRequest(suiteletUrl);
    }, 80);
  }

  function runGenerationRequest(suiteletUrl) {
    try {
      updateGenerationModal({
        state: 'running',
        title: 'Generation in Progress',
        message: 'Creating or marking the Project records. Please keep this page open.',
        percent: 55
      });

      sendAsyncGet(suiteletUrl, function (body) {
        var result;

        try {
          result = JSON.parse(body);
        } catch (parseError) {
          showGenerationError('Generation service returned an unexpected response.');
          return;
        }

        saveLastGenerationResult(result);

        if (result.success) {
          showGenerationComplete(result);
        } else if (result.partial || result.errors) {
          showGenerationPartial(result);
        } else {
          showGenerationError(result.error || 'Unknown error');
        }
      }, function (message) {
        showGenerationError(message);
      });
    } catch (e) {
      showGenerationError('Could not reach the generation service: ' + e.message);
    }
  }

  function sendAsyncGet(requestUrl, onSuccess, onError) {
    if (typeof XMLHttpRequest === 'undefined') {
      try {
        var resp = https.get({ url: requestUrl });
        onSuccess(resp.body);
      } catch (e) {
        onError('Could not reach the generation service: ' + e.message);
      }
      return;
    }

    var xhr = new XMLHttpRequest();
    xhr.open('GET', requestUrl, true);
    xhr.withCredentials = true;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;

      if (xhr.status >= 200 && xhr.status < 300) {
        onSuccess(xhr.responseText);
      } else {
        onError('Could not reach the generation service. HTTP status: ' + xhr.status);
      }
    };
    xhr.onerror = function () {
      onError('Could not reach the generation service.');
    };
    xhr.send();
  }

  function bcViewProjectProgress() {
    var rec = currentRecord.get();
    var estId = rec.id;

    var suiteletUrl = url.resolveScript({
      scriptId: SUITELET_SCRIPT_ID,
      deploymentId: SUITELET_DEPLOYMENT_ID,
      params: {
        action: 'progress',
        estid: estId
      }
    });

    showProjectProgressPopup(suiteletUrl);
  }

  function showGenerationRunning(estimateType) {
    var isRollout = estimateType === ESTIMATE_TYPE_ROLLOUT;

    updateGenerationModal({
      state: 'running',
      title: isRollout ? 'Starting Rollout Processing' : 'Generating Project',
      message: isRollout ?
        'Marking the rollout Estimate for processing and preparing Project progress.' :
        'Creating the Standard Project record.',
      percent: 35
    });
  }

  function showGenerationComplete(result) {
    var details = [];

    if (result.note) details.push(result.note);
    if (result.expectedProjectCount) details.push('Expected Projects: ' + result.expectedProjectCount);
    if (result.projectCount) details.push('Projects created: ' + result.projectCount);
    if (result.projectId) details.push('Project ID: ' + result.projectId);
    if (result.parentProjectId) details.push('Parent Project ID: ' + result.parentProjectId);

    if (generationModalDismissed) return;

    updateGenerationModal({
      state: 'complete',
      title: 'Generation Complete',
      message: 'Project progress has been updated for this Estimate.',
      percent: 100,
      details: details
    });
  }

  function showGenerationPartial(result) {
    var details = buildGenerationDetails(result);
    var expected = Number(result.expectedProjectCount || result.projectCount || 0);
    var created = Number(result.projectCount || 0);
    var percent = expected > 0 ? Math.min(100, Math.round((created / expected) * 100)) : 100;

    if (generationModalDismissed) {
      showCompactGenerationNotice(result);
      return;
    }

    updateGenerationModal({
      state: 'warning',
      title: 'Generation Completed with Errors',
      message: result.error || 'Some Project records could not be created. Review the failed attempts before re-running.',
      percent: percent,
      details: details
    });
  }

  function showGenerationError(message) {
    var result = {
      success: false,
      error: message,
      errors: [{
        label: 'Generation',
        message: message
      }]
    };

    saveLastGenerationResult(result);

    if (generationModalDismissed) {
      showCompactGenerationNotice(result);
      return;
    }

    updateGenerationModal({
      state: 'error',
      title: 'Generation Failed',
      message: message,
      percent: 100,
      details: ['No reload was performed. Fix the issue and run the generation again.']
    });
  }

  function buildGenerationDetails(result) {
    var details = [];

    if (result.note) details.push(result.note);
    if (result.expectedProjectCount !== undefined) details.push('Expected Projects: ' + result.expectedProjectCount);
    if (result.projectCount !== undefined) details.push('Projects created: ' + result.projectCount);
    if (result.failedProjectCount !== undefined) details.push('Project attempts failed: ' + result.failedProjectCount);
    if (result.expectedTaskCount !== undefined) details.push('Expected Project Tasks: ' + result.expectedTaskCount);
    if (result.taskCount !== undefined) details.push('Project Tasks created: ' + result.taskCount);
    if (result.failedTaskCount !== undefined) details.push('Project Tasks failed: ' + result.failedTaskCount);
    if (result.salesOrderCount !== undefined) details.push('Sales Orders created: ' + result.salesOrderCount);
    if (result.failedSalesOrderCount !== undefined) details.push('Sales Orders failed: ' + result.failedSalesOrderCount);
    if (result.salesOrderId) details.push('Sales Order ID: ' + result.salesOrderId);
    if (result.estimateLinesUpdated !== undefined) details.push('Estimate lines linked to Sales Order: ' + result.estimateLinesUpdated);
    if (result.warnings && result.warnings.length) details.push('Warnings: ' + result.warnings.length);

    if (result.errors && result.errors.length) {
      details.push('Errors:');
      for (var i = 0; i < result.errors.length && i < 8; i++) {
        details.push('- ' + formatProjectError(result.errors[i]));
      }
      if (result.errors.length > 8) {
        details.push('- ' + (result.errors.length - 8) + ' more errors. Use Show Progress or script logs for the full review.');
      }
    }

    return details;
  }

  function formatProjectError(err) {
    var label = err.label || 'Project';
    var site = err.siteText || err.siteId || (err.lineRef ? 'Line ' + err.lineRef : '');
    var message = err.message || 'Unknown error';

    return label + (site ? ' | Site: ' + site : '') + ' | ' + message;
  }

  function updateGenerationModal(opts) {
    ensureProgressStyles();

    var overlay = document.getElementById('bc_generation_overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'bc_generation_overlay';
      overlay.className = 'bc-progress-overlay';
      document.body.appendChild(overlay);
    }

    var stateClass = opts.state === 'error' ? 'bc-progress-error' :
      opts.state === 'warning' ? 'bc-progress-warning' :
      opts.state === 'complete' ? 'bc-progress-complete' : 'bc-progress-running';
    var details = opts.details && opts.details.length ? opts.details.map(function (line) {
      return '<div>' + escapeHtml(line) + '</div>';
    }).join('') : '';
    var closeButton =
      '<button type="button" id="bc_generation_close" class="bc-progress-secondary">Close</button>';
    var refreshButton = opts.state === 'complete' ?
      '<button type="button" id="bc_generation_refresh" class="bc-progress-primary">Refresh Estimate</button>' : '';
    var progressButton =
      '<button type="button" id="bc_generation_progress" class="bc-progress-secondary">Show Progress</button>';

    overlay.innerHTML =
      '<div class="bc-progress-card" role="dialog" aria-modal="true">' +
        '<div class="bc-progress-title">' + escapeHtml(opts.title || 'Generation Progress') + '</div>' +
        '<div class="bc-progress-message">' + escapeHtml(opts.message || '') + '</div>' +
        '<div class="bc-progress-track">' +
          '<div class="bc-progress-fill ' + stateClass + '" style="width:' + Number(opts.percent || 0) + '%;"></div>' +
        '</div>' +
        '<div class="bc-progress-details">' + details + '</div>' +
        '<div class="bc-progress-actions">' + progressButton + closeButton + refreshButton + '</div>' +
      '</div>';

    wireGenerationModalActions();
  }

  function wireGenerationModalActions() {
    var close = document.getElementById('bc_generation_close');
    var refresh = document.getElementById('bc_generation_refresh');
    var progress = document.getElementById('bc_generation_progress');

    if (close) {
      close.onclick = function () {
        generationModalDismissed = true;
        removeElement('bc_generation_overlay');
      };
    }

    if (refresh) {
      refresh.onclick = function () {
        window.location.reload();
      };
    }

    if (progress) {
      progress.onclick = function () {
        bcViewProjectProgress();
      };
    }
  }

  function showProjectProgressPopup(progressUrl) {
    ensureProgressStyles();
    closeProjectProgressPopup();
    var lastRunHtml = buildLastRunHtml();

    var overlay = document.createElement('div');
    overlay.id = 'bc_project_progress_overlay';
    overlay.className = 'bc-progress-overlay';
    overlay.innerHTML =
      '<div class="bc-progress-card bc-progress-card-wide" role="dialog" aria-modal="true">' +
        '<div class="bc-progress-popup-head">' +
          '<div>' +
            '<div class="bc-progress-title">Generation Progress</div>' +
            '<div class="bc-progress-message">Current Projects, Tasks, and Sales Orders. Use Refresh for latest values.</div>' +
          '</div>' +
          '<button type="button" id="bc_project_progress_close_x" class="bc-progress-icon-btn" aria-label="Close">x</button>' +
        '</div>' +
        lastRunHtml +
        '<iframe id="bc_project_progress_frame" class="bc-progress-frame" src="' + escapeAttribute(withCacheBuster(progressUrl)) + '"></iframe>' +
        '<div class="bc-progress-actions">' +
          '<button type="button" id="bc_project_progress_refresh" class="bc-progress-secondary">Refresh Progress</button>' +
          '<button type="button" id="bc_project_progress_close" class="bc-progress-primary">Close</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    document.getElementById('bc_project_progress_close').onclick = closeProjectProgressPopup;
    document.getElementById('bc_project_progress_close_x').onclick = closeProjectProgressPopup;
    document.getElementById('bc_project_progress_refresh').onclick = function () {
      refreshProjectProgressFrame(progressUrl);
    };
  }

  function refreshProjectProgressFrame(progressUrl) {
    var frame = document.getElementById('bc_project_progress_frame');
    if (frame) frame.src = withCacheBuster(progressUrl);
  }

  function withCacheBuster(rawUrl) {
    var joiner = String(rawUrl).indexOf('?') === -1 ? '?' : '&';
    return rawUrl + joiner + '_bc_ts=' + new Date().getTime();
  }

  function closeProjectProgressPopup() {
    if (projectProgressRefreshTimer) {
      window.clearInterval(projectProgressRefreshTimer);
      projectProgressRefreshTimer = null;
    }

    removeElement('bc_project_progress_overlay');
  }

  function ensureProgressStyles() {
    if (document.getElementById('bc_progress_styles')) return;

    var style = document.createElement('style');
    style.id = 'bc_progress_styles';
    style.textContent =
      '.bc-progress-overlay{position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,.38);display:flex;align-items:center;justify-content:center;padding:24px;font-family:Arial,sans-serif;}' +
      '.bc-progress-card{width:min(520px,calc(100vw - 32px));background:#fff;border:1px solid #cbd5e1;box-shadow:0 16px 34px rgba(15,23,42,.22);padding:14px;color:#1f2937;border-radius:6px;}' +
      '.bc-progress-card-wide{width:min(840px,calc(100vw - 32px));height:min(620px,calc(100vh - 32px));display:flex;flex-direction:column;}' +
      '.bc-progress-title{font-size:16px;font-weight:700;margin-bottom:3px;}' +
      '.bc-progress-message{font-size:12px;color:#4b5563;margin-bottom:10px;}' +
      '.bc-progress-track{height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden;position:relative;}' +
      '.bc-progress-fill{height:10px;border-radius:5px;transition:width .2s ease;background:#2563eb;}' +
      '.bc-progress-running{background:linear-gradient(90deg,#2563eb,#60a5fa,#2563eb);background-size:200% 100%;animation:bcProgressShift 1.1s linear infinite;}' +
      '.bc-progress-complete{background:#059669;}' +
      '.bc-progress-warning{background:#d97706;}' +
      '.bc-progress-error{background:#dc2626;}' +
      '.bc-progress-details{margin-top:10px;font-size:12px;color:#374151;line-height:1.35;max-height:150px;overflow:auto;}' +
      '.bc-progress-last-run{border:1px solid #f59e0b;background:#fffbeb;color:#92400e;padding:8px;margin-bottom:8px;font-size:12px;max-height:105px;overflow:auto;border-radius:4px;}' +
      '.bc-progress-last-run-title{font-weight:700;margin-bottom:4px;}' +
      '.bc-progress-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px;}' +
      '.bc-progress-primary,.bc-progress-secondary{border:1px solid #9ca3af;background:#fff;color:#1f2937;padding:5px 10px;cursor:pointer;font-size:12px;border-radius:4px;}' +
      '.bc-progress-primary{background:#2563eb;border-color:#2563eb;color:#fff;}' +
      '.bc-progress-popup-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;}' +
      '.bc-progress-icon-btn{border:1px solid #cbd5e1;background:#fff;color:#1f2937;width:24px;height:24px;cursor:pointer;font-weight:700;border-radius:4px;}' +
      '.bc-progress-frame{border:1px solid #e5e7eb;flex:1;width:100%;min-height:280px;background:#fff;}' +
      '.bc-progress-toast{position:fixed;right:18px;bottom:18px;z-index:100001;width:min(420px,calc(100vw - 36px));background:#fff;border:1px solid #f59e0b;box-shadow:0 12px 28px rgba(15,23,42,.22);padding:12px;border-radius:6px;color:#1f2937;font-family:Arial,sans-serif;}' +
      '.bc-progress-toast-title{font-size:14px;font-weight:700;margin-bottom:4px;}' +
      '.bc-progress-toast-message{font-size:12px;color:#4b5563;line-height:1.35;}' +
      '@keyframes bcProgressShift{0%{background-position:0 0;}100%{background-position:200% 0;}}';

    document.head.appendChild(style);
  }

  function removeElement(id) {
    var el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function hideGenerateButton() {
    try {
      var button = document.getElementById('custpage_bc_gen_proj_so');
      var matches = document.querySelectorAll('input[type="button"],button,a');

      if (button) {
        button.disabled = true;
        button.style.display = 'none';
      }

      for (var i = 0; i < matches.length; i++) {
        var el = matches[i];
        var label = el.value || el.textContent || '';

        if (String(label).replace(/\s+/g, ' ').trim() === 'Generate Project & Sales Order') {
          el.disabled = true;
          el.style.display = 'none';
        }
      }
    } catch (ignore) {
      // Button hiding is only user feedback; server-side checks still control generation.
    }
  }

  function saveLastGenerationResult(result) {
    try {
      window.sessionStorage.setItem(getLastRunStorageKey(), JSON.stringify(result));
    } catch (ignore) {
      // Session storage can be blocked by browser/account settings.
    }

    try {
      window.localStorage.setItem(getLastRunStorageKey(), JSON.stringify(result));
    } catch (ignoreLocal) {
      // Local storage can be blocked by browser/account settings.
    }
  }

  function getLastGenerationResult() {
    try {
      var raw = window.sessionStorage.getItem(getLastRunStorageKey());
      if (raw) return JSON.parse(raw);
    } catch (ignore) {
      // Try local storage below.
    }

    try {
      var localRaw = window.localStorage.getItem(getLastRunStorageKey());
      return localRaw ? JSON.parse(localRaw) : null;
    } catch (ignoreLocal) {
      return null;
    }
  }

  function getLastRunStorageKey() {
    var rec = currentRecord.get();
    return 'bc_project_generation_last_run_' + rec.id;
  }

  function buildLastRunHtml() {
    var result = getLastGenerationResult();
    if (!result || (!result.errors && !result.error)) return '';

    var title = result.success ? 'Last Run Status' :
      result.partial ? 'Last Run Completed with Errors' : 'Last Run Failed';
    var lines = buildGenerationDetails(result);

    if (!lines.length && result.error) lines.push(result.error);

    return '<div class="bc-progress-last-run">' +
      '<div class="bc-progress-last-run-title">' + escapeHtml(title) + '</div>' +
      lines.map(function (line) {
        return '<div>' + escapeHtml(line) + '</div>';
      }).join('') +
      '</div>';
  }

  function clearLastGenerationResult() {
    try {
      window.sessionStorage.removeItem(getLastRunStorageKey());
    } catch (ignore) {}

    try {
      window.localStorage.removeItem(getLastRunStorageKey());
    } catch (ignoreLocal) {}
  }

  function showCompactGenerationNotice(result) {
    ensureProgressStyles();
    removeElement('bc_generation_toast');

    var message = result.error || result.note || 'Generation completed with errors.';
    var toast = document.createElement('div');
    toast.id = 'bc_generation_toast';
    toast.className = 'bc-progress-toast';
    toast.innerHTML =
      '<div class="bc-progress-toast-title">Generation Needs Review</div>' +
      '<div class="bc-progress-toast-message">' + escapeHtml(message) + '</div>' +
      '<div class="bc-progress-actions">' +
        '<button type="button" id="bc_generation_toast_progress" class="bc-progress-secondary">Show Progress</button>' +
        '<button type="button" id="bc_generation_toast_close" class="bc-progress-primary">Close</button>' +
      '</div>';

    document.body.appendChild(toast);
    document.getElementById('bc_generation_toast_progress').onclick = bcViewProjectProgress;
    document.getElementById('bc_generation_toast_close').onclick = function () {
      removeElement('bc_generation_toast');
    };
  }

  function showStoredGenerationIssueBanner() {
    var result = getLastGenerationResult();
    if (!result || result.success === true || (!result.error && !(result.errors && result.errors.length))) return;

    showCompactGenerationNotice(result);
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  function exposeClientFunctions() {
    try {
      if (typeof window !== 'undefined') {
        window.bcGenerateProjectAndSO = bcGenerateProjectAndSO;
        window.bcViewProjectProgress = bcViewProjectProgress;
      }
    } catch (ignore) {
      // Ignore non-browser execution contexts.
    }
  }

  exposeClientFunctions();

  return {
    pageInit: pageInit,
    bcGenerateProjectAndSO: bcGenerateProjectAndSO,
    bcViewProjectProgress: bcViewProjectProgress
  };
});
