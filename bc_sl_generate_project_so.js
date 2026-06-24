/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * Script 1.0 (part C) — server-side generator.
 *
 * Phase 1 scope:
 * - Validate the approved Estimate.
 * - Create Project records for Standard and Rollout Estimates.
 * - Link generated Projects back to the source Estimate.
 * - Mark the Estimate as project-generated for this project-creation phase.
 *
 * Later phase:
 * - Create Project Tasks from CPQ staging records.
 * - Create related Sales Order records from CPQ component data.
 */
define(['N/record', 'N/search'], function (record, search) {

  // ---- Estimate field IDs --------------------------------------------------
  var EST = {
    ENTITY: 'entity',
    TRANID: 'tranid',
    SUBSIDIARY: 'subsidiary',
    SALESREP: 'salesrep',
    DEPARTMENT: 'department',
    CLASS: 'class',
    LOCATION: 'location',
    TRANDATE: 'trandate',
    PROJECTMANAGER: 'custbody_bc_project_manager',
    PROJECT_START: 'custbody_bc_project_start_date',
    PROJECT_END: 'custbody_bc_est_end_date',
    SITE_ASSET: 'custbody_nx_asset',
    FSM_CUSTOMER: 'custbody_nx_customer',
    APPROVAL_STATUS: 'custbody_bc_approval_stat_est',
    ESTIMATE_TYPE: 'custbody_bc_estimate_type',
    PROJECT_GENERATED: 'custbody_bc_project_generated',
    GENERATED_PROJECT: 'custbody_bc_project'
  };

  // ---- Estimate line field IDs --------------------------------------------
  var EST_LINE = {
    SITE_ASSET: 'custcol_nx_asset'
  };

  // ---- Project field IDs ---------------------------------------------------
  var PROJ = {
    NAME: 'companyname',
    PARENT: 'parent',
    SUBSIDIARY: 'subsidiary',
    STARTDATE: 'startdate',
    PROJECTED_END: 'projectedenddate',
    SALESREP: 'custentity_salesrep',
    DEPARTMENT: 'department',
    CLASS: 'class',
    LOCATION: 'location',
    PROJECTMANAGER: 'projectmanager',
    FS_PROJECT_TYPE: 'custentity_nx_project_type',
    SITE_ASSET: 'custentity_nx_asset',
    FS_CUSTOMER: 'custentity_nx_customer',
    SOURCE_ESTIMATE: 'custentity_bc_source_estimate'
  };

  var APPROVED_STATUS_VALUE = '2';
  var ESTIMATE_TYPE_STANDARD = '1';
  var ESTIMATE_TYPE_ROLLOUT = '2';
  var FIXED_FEE_PROJECT_TYPE = '18';

  function onRequest(ctx) {
    var out = { success: false };

    try {
      var estId = ctx.request.parameters.estid;
      if (!estId) throw new Error('Missing estid parameter.');

      if (ctx.request.parameters.action === 'progress') {
        writeProjectProgressPage(ctx, estId);
        return;
      }

      var est = record.load({
        type: record.Type.ESTIMATE,
        id: estId,
        isDynamic: false
      });

      validateEstimate(est, estId);

      var estimateType = String(est.getValue(EST.ESTIMATE_TYPE) || '');

      if (estimateType === ESTIMATE_TYPE_STANDARD) {
        out = runStandardProjectCreation(est, estId);
      } else if (estimateType === ESTIMATE_TYPE_ROLLOUT) {
        out = runRolloutProjectCreation(est, estId);
      } else {
        throw new Error('Unsupported or missing Estimate Type. Expected Standard (1) or Rollout (2).');
      }
    } catch (e) {
      out.success = false;
      out.error = e.message || String(e);
    }

    ctx.response.write({ output: JSON.stringify(out) });
  }

  function writeProjectProgressPage(ctx, estId) {
    var est = record.load({
      type: record.Type.ESTIMATE,
      id: estId,
      isDynamic: false
    });

    var progress = getProjectProgress(est, estId);
    ctx.response.write({ output: buildProjectProgressPage(progress) });
  }

  function getProjectProgress(est, estId) {
    var estimateType = String(est.getValue(EST.ESTIMATE_TYPE) || '');
    var expected = getExpectedProjectCount(est);
    var projects = getGeneratedProjects(estId);
    var created = projects.length;
    var percent = expected > 0 ? Math.min(100, Math.round((created / expected) * 100)) : 0;
    var generated = est.getValue(EST.PROJECT_GENERATED) === true;
    var status = getProjectProgressStatusDetails(expected, created, generated);

    return {
      estimateId: estId,
      estimateTranId: est.getValue(EST.TRANID),
      estimateType: estimateType,
      expected: expected,
      created: created,
      remaining: Math.max(expected - created, 0),
      percent: percent,
      generated: generated,
      statusCode: status.code,
      statusText: status.text,
      projects: projects
    };
  }

  function getExpectedProjectCount(est) {
    var estimateType = String(est.getValue(EST.ESTIMATE_TYPE) || '');

    if (estimateType === ESTIMATE_TYPE_STANDARD) return 1;

    if (estimateType === ESTIMATE_TYPE_ROLLOUT) {
      var siteCount = getUniqueLineSites(est).length;
      return siteCount > 0 ? siteCount + 1 : 0;
    }

    return 0;
  }

  function getGeneratedProjects(estId) {
    var projects = [];

    search.create({
      type: search.Type.JOB,
      filters: [[PROJ.SOURCE_ESTIMATE, 'anyof', estId]],
      columns: [
        search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
        search.createColumn({ name: 'entityid' }),
        search.createColumn({ name: 'parent' }),
        search.createColumn({ name: PROJ.SITE_ASSET })
      ]
    }).run().each(function (result) {
      projects.push({
        id: result.getValue({ name: 'internalid' }),
        name: result.getValue({ name: 'entityid' }),
        parent: result.getText({ name: 'parent' }) || result.getValue({ name: 'parent' }),
        site: result.getText({ name: PROJ.SITE_ASSET }) || result.getValue({ name: PROJ.SITE_ASSET })
      });
      return true;
    });

    return projects;
  }

  function buildProjectProgressPage(progress) {
    var complete = progress.statusCode === 'COMPLETE';
    var refresh = complete ? '' : '<meta http-equiv="refresh" content="5">';
    var warning = progress.statusCode === 'WARNING' ?
      '<div class="warn">The Estimate is marked generated, but the Project count does not match the expected count. Review the generated Projects before re-running.</div>' : '';
    var rows = progress.projects.length ? progress.projects.map(function (project) {
      return '<tr>' +
        '<td>' + escapeHtml(project.id) + '</td>' +
        '<td>' + escapeHtml(project.name) + '</td>' +
        '<td>' + escapeHtml(project.parent) + '</td>' +
        '<td>' + escapeHtml(project.site || 'Parent / No Site') + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="4">No generated Projects found yet.</td></tr>';

    return '<!doctype html>' +
      '<html><head><title>Project Progress</title>' + refresh +
      '<style>' +
      'body{font-family:Arial,sans-serif;margin:24px;color:#1f2937;background:#f8fafc;}' +
      '.wrap{max-width:980px;margin:0 auto;background:#fff;border:1px solid #d9e2ec;padding:20px;}' +
      '.bar{height:18px;background:#e5e7eb;border-radius:9px;overflow:hidden;margin:14px 0;}' +
      '.fill{height:18px;background:' + getBarColor(progress.statusCode) + ';width:' + progress.percent + '%;}' +
      '.summary{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:18px 0;}' +
      '.box{border:1px solid #e5e7eb;background:#f9fafb;padding:12px;}' +
      '.label{font-size:12px;color:#6b7280;text-transform:uppercase;}' +
      '.value{font-size:20px;font-weight:700;margin-top:4px;}' +
      '.warn{border:1px solid #f59e0b;background:#fffbeb;color:#92400e;padding:10px;margin:12px 0;}' +
      'table{width:100%;border-collapse:collapse;margin-top:16px;}' +
      'th,td{border:1px solid #e5e7eb;padding:8px;text-align:left;}' +
      'th{background:#f3f4f6;}' +
      '</style></head><body><div class="wrap">' +
      '<h2>Project Generation Progress</h2>' +
      '<div>Estimate: ' + escapeHtml(progress.estimateTranId || progress.estimateId) + '</div>' +
      '<div class="bar"><div class="fill"></div></div>' +
      '<div>Projects created: <strong>' + progress.created + '</strong> of <strong>' + progress.expected + '</strong> (' + progress.percent + '%)</div>' +
      warning +
      '<div class="summary">' +
        '<div class="box"><div class="label">Flow</div><div class="value">' + escapeHtml(getEstimateTypeLabel(progress.estimateType)) + '</div></div>' +
        '<div class="box"><div class="label">Expected</div><div class="value">' + progress.expected + '</div></div>' +
        '<div class="box"><div class="label">Created</div><div class="value">' + progress.created + '</div></div>' +
        '<div class="box"><div class="label">Remaining</div><div class="value">' + progress.remaining + '</div></div>' +
        '<div class="box"><div class="label">Status</div><div class="value">' + escapeHtml(progress.statusText) + '</div></div>' +
      '</div>' +
      '<h3>Generated Projects</h3>' +
      '<table><thead><tr><th>Internal ID</th><th>Name / ID</th><th>Parent</th><th>Site</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p style="color:#6b7280;margin-top:16px;">This page refreshes automatically until all expected Project records are found.</p>' +
      '</div></body></html>';
  }

  function getProjectProgressStatusDetails(expected, created, generated) {
    if (!expected) return { code: 'WAITING', text: 'Waiting' };
    if (created >= expected) return { code: 'COMPLETE', text: 'Complete' };
    if (generated && created < expected) return { code: 'WARNING', text: 'Warning' };
    if (created > 0) return { code: 'PROCESSING', text: 'Processing' };
    return { code: 'NOT_STARTED', text: 'Not Started' };
  }

  function getBarColor(statusCode) {
    if (statusCode === 'COMPLETE') return '#059669';
    if (statusCode === 'WARNING') return '#d97706';
    if (statusCode === 'PROCESSING') return '#2563eb';
    return '#94a3b8';
  }

  function getEstimateTypeLabel(value) {
    if (value === ESTIMATE_TYPE_STANDARD) return 'Standard';
    if (value === ESTIMATE_TYPE_ROLLOUT) return 'Rollout';
    return 'Missing';
  }

  function validateEstimate(est, estId) {
    if (String(est.getValue(EST.APPROVAL_STATUS)) !== APPROVED_STATUS_VALUE) {
      throw new Error('Estimate is not in customer-approved status.');
    }

    if (est.getValue(EST.PROJECT_GENERATED) === true) {
      throw new Error('Project already generated for this estimate.');
    }

    if (hasExistingGeneratedProjects(estId)) {
      throw new Error('Project records already exist for this estimate. Delete or review them before re-running.');
    }

    if (!est.getValue(EST.PROJECT_END)) {
      throw new Error('Estimated End Date is required before creating Project records.');
    }
  }

  function runStandardProjectCreation(est, estId) {
    var projectId = createProject({
      estimate: est,
      estimateId: estId,
      parentId: est.getValue(EST.ENTITY),
      siteAssetId: est.getValue(EST.SITE_ASSET),
      namePrefix: 'Project'
    });

    markEstimateGenerated(estId, projectId);

    return {
      success: true,
      flowType: 'STANDARD',
      projectId: projectId,
      projectCount: 1,
      note: 'Standard project created. Project Tasks and Sales Order are pending a later phase.'
    };
  }

  function runRolloutProjectCreation(est, estId) {
    var sites = getUniqueLineSites(est);
    if (!sites.length) {
      throw new Error('Rollout Estimate has no unique line-level Site Assets in ' + EST_LINE.SITE_ASSET + '.');
    }

    var parentProjectId = createProject({
      estimate: est,
      estimateId: estId,
      parentId: est.getValue(EST.ENTITY),
      siteAssetId: null,
      namePrefix: 'Rollout Parent'
    });

    var childProjectIds = [];
    for (var i = 0; i < sites.length; i++) {
      childProjectIds.push(createProject({
        estimate: est,
        estimateId: estId,
        parentId: parentProjectId,
        siteAssetId: sites[i].id,
        namePrefix: 'Rollout Site ' + (sites[i].text || sites[i].id)
      }));
    }

    markEstimateGenerated(estId, parentProjectId);

    return {
      success: true,
      flowType: 'ROLLOUT',
      parentProjectId: parentProjectId,
      childProjectIds: childProjectIds,
      siteCount: sites.length,
      projectCount: childProjectIds.length + 1,
      note: 'Rollout parent and child projects created. Project Tasks and Sales Orders are pending a later phase.'
    };
  }

  function createProject(opts) {
    var est = opts.estimate;
    var project = record.create({ type: record.Type.JOB, isDynamic: true });

    project.setValue({ fieldId: PROJ.PARENT, value: opts.parentId });
    project.setValue({ fieldId: PROJ.SUBSIDIARY, value: est.getValue(EST.SUBSIDIARY) });
    project.setValue({ fieldId: PROJ.STARTDATE, value: est.getValue(EST.PROJECT_START) || est.getValue(EST.TRANDATE) });
    project.setValue({ fieldId: PROJ.PROJECTED_END, value: est.getValue(EST.PROJECT_END) });
    project.setValue({ fieldId: PROJ.FS_PROJECT_TYPE, value: FIXED_FEE_PROJECT_TYPE });
    project.setValue({ fieldId: PROJ.SOURCE_ESTIMATE, value: opts.estimateId });

    setIfPresent(project, PROJ.NAME, makeProjectName(opts.namePrefix, est.getValue(EST.TRANID)));
    setIfPresent(project, PROJ.SALESREP, est.getValue(EST.SALESREP));
    setIfPresent(project, PROJ.DEPARTMENT, est.getValue(EST.DEPARTMENT));
    setIfPresent(project, PROJ.CLASS, est.getValue(EST.CLASS));
    setIfPresent(project, PROJ.LOCATION, est.getValue(EST.LOCATION));
    setIfPresent(project, PROJ.PROJECTMANAGER, est.getValue(EST.PROJECTMANAGER));
    setIfPresent(project, PROJ.SITE_ASSET, opts.siteAssetId);

    project.setValue({
      fieldId: PROJ.FS_CUSTOMER,
      value: est.getValue(EST.FSM_CUSTOMER) || est.getValue(EST.ENTITY)
    });

    return project.save({ enableSourcing: true, ignoreMandatoryFields: true });
  }

  function markEstimateGenerated(estId, projectId) {
    var values = {};
    values[EST.PROJECT_GENERATED] = true;
    values[EST.GENERATED_PROJECT] = projectId;

    record.submitFields({
      type: record.Type.ESTIMATE,
      id: estId,
      values: values
    });
  }

  function getUniqueLineSites(est) {
    var seen = {};
    var sites = [];
    var lineCount = est.getLineCount({ sublistId: 'item' });

    for (var i = 0; i < lineCount; i++) {
      var siteId = est.getSublistValue({
        sublistId: 'item',
        fieldId: EST_LINE.SITE_ASSET,
        line: i
      });

      if (!siteId || seen[String(siteId)]) continue;

      seen[String(siteId)] = true;
      sites.push({
        id: siteId,
        text: est.getSublistText({
          sublistId: 'item',
          fieldId: EST_LINE.SITE_ASSET,
          line: i
        })
      });
    }

    return sites;
  }

  function hasExistingGeneratedProjects(estId) {
    return search.create({
      type: search.Type.JOB,
      filters: [[PROJ.SOURCE_ESTIMATE, 'anyof', estId]],
      columns: ['internalid']
    }).runPaged({ pageSize: 1 }).count > 0;
  }

  function makeProjectName(prefix, tranId) {
    return prefix + ' - Estimate ' + (tranId || '');
  }

  function setIfPresent(rec, fieldId, value) {
    if (value !== '' && value !== null && value !== undefined) {
      rec.setValue({ fieldId: fieldId, value: value });
    }
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  return { onRequest: onRequest };
});
