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
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

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
    CUSTOMER_PARENT: 'parent', // UI label is Customer; field ID on Job/Project is parent.
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
    SOURCE_ESTIMATE: 'custentity_bc_source_estimate',
    SEARCH_CUSTOMER: 'customer'
  };

  var APPROVED_STATUS_VALUE = '2';
  var ESTIMATE_TYPE_STANDARD = '1';
  var ESTIMATE_TYPE_ROLLOUT = '2';
  var FIXED_FEE_PROJECT_TYPE = '18';

  // SANDBOX TEST ONLY: set to false before moving beyond progress-bar testing.
  var PROGRESS_TEST_MODE = true;
  var PROGRESS_TEST_STANDARD_PROJECT_COUNT = 10;

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

    if (ctx.request.parameters.format === 'json') {
      ctx.response.write({ output: JSON.stringify(out) });
    } else {
      ctx.response.write({ output: buildGenerationResultPage(out) });
    }
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

    if (estimateType === ESTIMATE_TYPE_STANDARD) {
      return PROGRESS_TEST_MODE ? PROGRESS_TEST_STANDARD_PROJECT_COUNT : 1;
    }

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
        search.createColumn({ name: PROJ.SEARCH_CUSTOMER }),
        search.createColumn({ name: PROJ.SITE_ASSET })
      ]
    }).run().each(function (result) {
      projects.push({
        id: result.getValue({ name: 'internalid' }),
        name: result.getValue({ name: 'entityid' }),
        parent: result.getText({ name: PROJ.SEARCH_CUSTOMER }) || result.getValue({ name: PROJ.SEARCH_CUSTOMER }),
        site: result.getText({ name: PROJ.SITE_ASSET }) || result.getValue({ name: PROJ.SITE_ASSET })
      });
      return true;
    });

    return projects;
  }

  function buildProjectProgressPage(progress) {
    var complete = progress.statusCode === 'COMPLETE';
    var refresh = complete ? '' : '<meta http-equiv="refresh" content="2">';
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
    if (created > 0) return { code: 'PROCESSING', text: 'Processing / Partial' };
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

    if (!PROGRESS_TEST_MODE && hasExistingGeneratedProjects(estId)) {
      throw new Error('Project records already exist for this estimate. Delete or review them before re-running.');
    }

    if (!est.getValue(EST.PROJECT_END)) {
      throw new Error('Estimated End Date is required before creating Project records.');
    }
  }

  function runStandardProjectCreation(est, estId) {
    var targetCount = PROGRESS_TEST_MODE ? PROGRESS_TEST_STANDARD_PROJECT_COUNT : 1;
    var projectIds = [];
    var errors = [];

    for (var i = 0; i < targetCount; i++) {
      var attempt = {
        estimate: est,
        estimateId: estId,
        parentId: est.getValue(EST.ENTITY),
        siteAssetId: est.getValue(EST.SITE_ASSET),
        namePrefix: targetCount > 1 ? 'Progress Test Project ' + padNumber(i + 1) : 'Project',
        attemptLabel: targetCount > 1 ? 'Standard Project ' + padNumber(i + 1) : 'Standard Project'
      };

      var result = tryCreateProject(attempt);
      if (result.projectId) projectIds.push(result.projectId);
      if (result.error) errors.push(result.error);
    }

    var projectId = projectIds[0];

    if (errors.length) {
      return buildPartialFailureResult({
        flowType: 'STANDARD',
        expectedProjectCount: targetCount,
        projectIds: projectIds,
        errors: errors,
        note: 'Standard Project generation completed with errors. Review the failed attempts, fix the data, and re-run as needed.'
      });
    }

    markEstimateGenerated(estId, projectId);

    return {
      success: true,
      flowType: 'STANDARD',
      projectId: projectId,
      projectIds: projectIds,
      projectCount: projectIds.length,
      testMode: PROGRESS_TEST_MODE,
      note: PROGRESS_TEST_MODE ?
        'Progress test mode created ' + projectIds.length + ' Standard Projects. Turn off test mode after validation.' :
        'Standard project created. Project Tasks and Sales Order are pending a later phase.'
    };
  }

  function runRolloutProjectCreation(est, estId) {
    var sites = getUniqueLineSites(est);
    if (!sites.length) {
      throw new Error('Rollout Estimate has no unique line-level Site Assets in ' + EST_LINE.SITE_ASSET + '.');
    }

    var errors = [];
    var parentProjectId;
    var parentResult = tryCreateProject({
      estimate: est,
      estimateId: estId,
      parentId: est.getValue(EST.ENTITY),
      siteAssetId: null,
      namePrefix: 'Rollout Parent',
      attemptLabel: 'Rollout Parent Project'
    });

    if (parentResult.projectId) parentProjectId = parentResult.projectId;
    if (parentResult.error) errors.push(parentResult.error);

    var childProjectIds = [];
    if (parentProjectId) {
      for (var i = 0; i < sites.length; i++) {
        var childResult = tryCreateProject({
          estimate: est,
          estimateId: estId,
          parentId: parentProjectId,
          siteAssetId: sites[i].id,
          siteText: sites[i].text,
          namePrefix: 'Rollout Site ' + (sites[i].text || sites[i].id),
          attemptLabel: 'Rollout Child Project for Site ' + (sites[i].text || sites[i].id)
        });

        if (childResult.projectId) childProjectIds.push(childResult.projectId);
        if (childResult.error) errors.push(childResult.error);
      }
    } else {
      for (var s = 0; s < sites.length; s++) {
        errors.push({
          label: 'Rollout Child Project for Site ' + (sites[s].text || sites[s].id),
          siteId: sites[s].id,
          siteText: sites[s].text,
          message: 'Skipped because the parent Project was not created.'
        });
      }
    }

    if (errors.length) {
      var allProjectIds = parentProjectId ? [parentProjectId].concat(childProjectIds) : childProjectIds;
      return buildPartialFailureResult({
        flowType: 'ROLLOUT',
        parentProjectId: parentProjectId,
        childProjectIds: childProjectIds,
        projectIds: allProjectIds,
        expectedProjectCount: sites.length + 1,
        siteCount: sites.length,
        errors: errors,
        note: 'Rollout Project generation completed with errors. Successful Projects were left in place for review.'
      });
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

    project.setValue({ fieldId: PROJ.CUSTOMER_PARENT, value: opts.parentId });
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

  function tryCreateProject(opts) {
    try {
      return {
        projectId: createProject(opts),
        error: null
      };
    } catch (e) {
      var error = {
        label: opts.attemptLabel || opts.namePrefix || 'Project',
        siteId: opts.siteAssetId || '',
        siteText: opts.siteText || '',
        message: e.message || String(e)
      };

      log.error({
        title: 'BC Project generation failed: ' + error.label,
        details: JSON.stringify(error)
      });

      return {
        projectId: null,
        error: error
      };
    }
  }

  function buildPartialFailureResult(opts) {
    var createdCount = opts.projectIds ? opts.projectIds.length : 0;
    var expectedCount = opts.expectedProjectCount || createdCount;

    return {
      success: false,
      partial: createdCount > 0,
      flowType: opts.flowType,
      parentProjectId: opts.parentProjectId,
      childProjectIds: opts.childProjectIds || [],
      projectIds: opts.projectIds || [],
      projectCount: createdCount,
      expectedProjectCount: expectedCount,
      failedProjectCount: opts.errors.length,
      siteCount: opts.siteCount,
      errors: opts.errors,
      note: opts.note,
      error: 'Project generation completed with errors. Created ' + createdCount + ' of ' + expectedCount + ' expected Projects.'
    };
  }

  function buildGenerationResultPage(result) {
    var success = result.success === true;
    var partial = result.partial === true;
    var statusText = success ? 'Complete' : partial ? 'Completed with Errors' : 'Failed';
    var barColor = success ? '#059669' : partial ? '#d97706' : '#dc2626';
    var expected = result.expectedProjectCount || result.projectCount || 0;
    var created = result.projectCount || 0;
    var percent = expected ? Math.min(100, Math.round((created / expected) * 100)) : (success ? 100 : 0);
    var errorRows = result.errors && result.errors.length ? result.errors.map(function (err) {
      return '<tr>' +
        '<td>' + escapeHtml(err.label || '') + '</td>' +
        '<td>' + escapeHtml(err.siteText || err.siteId || '') + '</td>' +
        '<td>' + escapeHtml(err.message || '') + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="3">No project-level errors were returned.</td></tr>';

    return '<!doctype html><html><head><title>Project Generation Status</title>' +
      '<style>' +
      'body{font-family:Arial,sans-serif;margin:24px;color:#1f2937;background:#f8fafc;}' +
      '.wrap{max-width:980px;margin:0 auto;background:#fff;border:1px solid #d9e2ec;padding:20px;}' +
      '.bar{height:18px;background:#e5e7eb;border-radius:9px;overflow:hidden;margin:14px 0;}' +
      '.fill{height:18px;background:' + barColor + ';width:' + percent + '%;}' +
      '.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0;}' +
      '.box{border:1px solid #e5e7eb;background:#f9fafb;padding:12px;}' +
      '.label{font-size:12px;color:#6b7280;text-transform:uppercase;}' +
      '.value{font-size:20px;font-weight:700;margin-top:4px;}' +
      'table{width:100%;border-collapse:collapse;margin-top:16px;}' +
      'th,td{border:1px solid #e5e7eb;padding:8px;text-align:left;vertical-align:top;}' +
      'th{background:#f3f4f6;}' +
      '</style></head><body><div class="wrap">' +
      '<h2>Project Generation Status</h2>' +
      '<div>Status: <strong>' + escapeHtml(statusText) + '</strong></div>' +
      '<div class="bar"><div class="fill"></div></div>' +
      '<div>' + escapeHtml(result.note || result.error || '') + '</div>' +
      '<div class="summary">' +
        '<div class="box"><div class="label">Flow</div><div class="value">' + escapeHtml(result.flowType || '') + '</div></div>' +
        '<div class="box"><div class="label">Expected</div><div class="value">' + expected + '</div></div>' +
        '<div class="box"><div class="label">Created</div><div class="value">' + created + '</div></div>' +
        '<div class="box"><div class="label">Failed</div><div class="value">' + (result.failedProjectCount || 0) + '</div></div>' +
      '</div>' +
      '<h3>Project Errors</h3>' +
      '<table><thead><tr><th>Attempt</th><th>Site</th><th>Error</th></tr></thead><tbody>' + errorRows + '</tbody></table>' +
      '</div></body></html>';
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

  function padNumber(value) {
    return value < 10 ? '0' + value : String(value);
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
