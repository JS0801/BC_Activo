/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 *
 * Script 1.0 (part B) — client handler for the Generate button.
 * Calls the Suitelet that performs the server-side record creation,
 * shows the result, and reloads the Estimate.
 *
 * Owner: BlueCollar (Tom F.)
 */
define(['N/url', 'N/https', 'N/currentRecord'], function (url, https, currentRecord) {

  var SUITELET_SCRIPT_ID = 'customscript_bc_sl_generate_proj_so';
  var SUITELET_DEPLOYMENT_ID = 'customdeploy_bc_sl_generate_proj_so';
  var ESTIMATE_TYPE_FIELD = 'custbody_bc_estimate_type';
  var ESTIMATE_TYPE_ROLLOUT = '2';

  function pageInit() {
    exposeClientFunctions();
  }

  // Global so the button (functionName) can find it.
  function bcGenerateProjectAndSO() {
    var rec = currentRecord.get();
    var estId = rec.id;
    var estimateType = String(rec.getValue({ fieldId: ESTIMATE_TYPE_FIELD }) || '');

    var suiteletUrl = url.resolveScript({
      scriptId: SUITELET_SCRIPT_ID,
      deploymentId: SUITELET_DEPLOYMENT_ID,
      params: { estid: estId }
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

      var resp = https.get({ url: suiteletUrl });
      var result = JSON.parse(resp.body);

      if (result.success) {
        showGenerationComplete(result);
      } else {
        showGenerationError(result.error || 'Unknown error');
      }
    } catch (e) {
      showGenerationError('Could not reach the generation service: ' + e.message);
    }
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
    if (result.projectCount) details.push('Projects created: ' + result.projectCount);
    if (result.projectId) details.push('Project ID: ' + result.projectId);
    if (result.parentProjectId) details.push('Parent Project ID: ' + result.parentProjectId);

    updateGenerationModal({
      state: 'complete',
      title: 'Generation Complete',
      message: 'Project progress has been updated for this Estimate.',
      percent: 100,
      details: details
    });
  }

  function showGenerationError(message) {
    updateGenerationModal({
      state: 'error',
      title: 'Generation Failed',
      message: message,
      percent: 100,
      details: ['No reload was performed. Fix the issue and run the generation again.']
    });
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
      opts.state === 'complete' ? 'bc-progress-complete' : 'bc-progress-running';
    var details = opts.details && opts.details.length ? opts.details.map(function (line) {
      return '<div>' + escapeHtml(line) + '</div>';
    }).join('') : '';
    var closeButton = opts.state === 'running' ? '' :
      '<button type="button" id="bc_generation_close" class="bc-progress-secondary">Close</button>';
    var refreshButton = opts.state === 'complete' ?
      '<button type="button" id="bc_generation_refresh" class="bc-progress-primary">Refresh Estimate</button>' : '';
    var progressButton = opts.state !== 'running' ?
      '<button type="button" id="bc_generation_progress" class="bc-progress-secondary">Show Progress</button>' : '';

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
    removeElement('bc_project_progress_overlay');

    var overlay = document.createElement('div');
    overlay.id = 'bc_project_progress_overlay';
    overlay.className = 'bc-progress-overlay';
    overlay.innerHTML =
      '<div class="bc-progress-card bc-progress-card-wide" role="dialog" aria-modal="true">' +
        '<div class="bc-progress-popup-head">' +
          '<div>' +
            '<div class="bc-progress-title">Project Progress</div>' +
            '<div class="bc-progress-message">Current Project creation details for this Estimate.</div>' +
          '</div>' +
          '<button type="button" id="bc_project_progress_close_x" class="bc-progress-icon-btn" aria-label="Close">x</button>' +
        '</div>' +
        '<iframe id="bc_project_progress_frame" class="bc-progress-frame" src="' + escapeAttribute(progressUrl) + '"></iframe>' +
        '<div class="bc-progress-actions">' +
          '<button type="button" id="bc_project_progress_refresh" class="bc-progress-secondary">Refresh Progress</button>' +
          '<button type="button" id="bc_project_progress_close" class="bc-progress-primary">Close</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    document.getElementById('bc_project_progress_close').onclick = function () {
      removeElement('bc_project_progress_overlay');
    };
    document.getElementById('bc_project_progress_close_x').onclick = function () {
      removeElement('bc_project_progress_overlay');
    };
    document.getElementById('bc_project_progress_refresh').onclick = function () {
      document.getElementById('bc_project_progress_frame').src = progressUrl;
    };
  }

  function ensureProgressStyles() {
    if (document.getElementById('bc_progress_styles')) return;

    var style = document.createElement('style');
    style.id = 'bc_progress_styles';
    style.textContent =
      '.bc-progress-overlay{position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,.38);display:flex;align-items:center;justify-content:center;padding:24px;font-family:Arial,sans-serif;}' +
      '.bc-progress-card{width:min(560px,calc(100vw - 48px));background:#fff;border:1px solid #cbd5e1;box-shadow:0 20px 45px rgba(15,23,42,.25);padding:20px;color:#1f2937;}' +
      '.bc-progress-card-wide{width:min(980px,calc(100vw - 48px));height:min(760px,calc(100vh - 48px));display:flex;flex-direction:column;}' +
      '.bc-progress-title{font-size:18px;font-weight:700;margin-bottom:6px;}' +
      '.bc-progress-message{font-size:13px;color:#4b5563;margin-bottom:14px;}' +
      '.bc-progress-track{height:16px;background:#e5e7eb;border-radius:8px;overflow:hidden;position:relative;}' +
      '.bc-progress-fill{height:16px;border-radius:8px;transition:width .2s ease;background:#2563eb;}' +
      '.bc-progress-running{background:linear-gradient(90deg,#2563eb,#60a5fa,#2563eb);background-size:200% 100%;animation:bcProgressShift 1.1s linear infinite;}' +
      '.bc-progress-complete{background:#059669;}' +
      '.bc-progress-error{background:#dc2626;}' +
      '.bc-progress-details{margin-top:14px;font-size:13px;color:#374151;line-height:1.5;}' +
      '.bc-progress-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px;}' +
      '.bc-progress-primary,.bc-progress-secondary{border:1px solid #9ca3af;background:#fff;color:#1f2937;padding:7px 12px;cursor:pointer;}' +
      '.bc-progress-primary{background:#2563eb;border-color:#2563eb;color:#fff;}' +
      '.bc-progress-popup-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;}' +
      '.bc-progress-icon-btn{border:1px solid #cbd5e1;background:#fff;color:#1f2937;width:28px;height:28px;cursor:pointer;font-weight:700;}' +
      '.bc-progress-frame{border:1px solid #e5e7eb;flex:1;width:100%;min-height:320px;background:#fff;}' +
      '@keyframes bcProgressShift{0%{background-position:0 0;}100%{background-position:200% 0;}}';

    document.head.appendChild(style);
  }

  function removeElement(id) {
    var el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
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
