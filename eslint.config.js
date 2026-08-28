'use strict';

const js = require('@eslint/js');
const globals = require('globals');

const frontendShared = [
  'appState', 'sections', 'menuItems', 'sectionTitle', 'sectionSubtitle',
  'navDashboard', 'navConsultas', 'navRegistro', 'navFuncionarios', 'navExpedientes',
  'navAuditoria', 'navEliminaciones', 'statTotalDocs', 'statPendingDocs',
  'statTotalEmployees', 'statUnregisteredDocs', 'badgeUnregistered', 'userInfo',
  'modalViewPdf', 'modalEditDoc', 'modalAddEmp', 'setupNavigation', 'loadAllData',
  'fetchStats', 'fetchEmployees', 'fetchUnregisteredFiles', 'submittingUpload',
  'setupEventListeners', 'refreshActiveSectionViews', 'reloadAll', 'sanitize',
  'escOnclick', 'getToken', 'getUser', 'logout', 'checkAuth', 'apiFetch',
  'apiFetchWithRetry', 'showToast', 'removeToast', 'showLoader', 'hideLoader',
  'openModal', 'closeModal', 'getInitials', 'formatIssueDate', 'formatDate',
  'populateDropdown', 'populateSelect', 'guardSubmit', 'initTheme', 'updateThemeUI',
  'setupThemeToggle', 'evaluatePasswordStrength', 'bindPasswordStrengthMeter',
  'renderPdfFallback', 'openPdfViewer', 'closePdfViewer', 'setupDragDrop',
  'portalState', 'checkAuthFuncionario', 'showPortalApp', 'loadPortalData',
  'renderPortalDocs', 'renderPortalScannerFiles', 'renderPortalEmailInbox',
  'handlePortalUpload', 'submittingScannerReg', 'handleRegisterScanner',
  'submittingEmailReg', 'handleRegisterEmailAttachment',
  'loadFuncionarioDeletionRequests', 'submittingChangePw', 'handleChangePassword',
  'refreshPortalScannerStatus', 'closePortalPdf', 'renderAuditLogsTable',
  'renderDeletionRequests', 'renderStats', 'renderDashboardChart',
  'renderDashboardEmployees', 'renderRecentActivity', 'formatRelativeTime',
  'fetchSystemStatus', 'renderSystemStatus', 'renderEmployeesTable',
  'renderEmployeeDirectory', 'selectEmployeeForFolder', 'renderEmployeeDossier',
  'setFolderCategory', 'renderDocumentsTable', 'renderUnregisteredFiles',
  'openRegisterModal', 'triggerAnalysis', 'updateDocumentStatus',
  'toggleDocVisibility', 'fetchScannerFiles', 'renderScannerFiles',
  'fetchGmailStatus', 'renderGmailStatusBanner', 'startGmailAuthorization',
  'fetchEmails', 'renderEmailInbox', 'selectEmail', 'renderEmailDetail',
  'refreshScannerStatus', 'switchSubTab', 'portalShowTab', 'archiveDocument'
];

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'storage/**',
      'bandeja_escaner/**',
      'scripts/**',
      'backups/**'
    ]
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.commonjs }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { args: 'none', argsIgnorePattern: '^_' }],
      'no-useless-assignment': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': 'off',
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
      'no-useless-catch': 'off',
      'no-fallthrough': 'off',
      'no-self-assign': 'off',
      'no-prototype-builtins': 'off'
    }
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, ...Object.fromEntries(frontendShared.map(n => [n, 'writable'])) }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-redeclare': 'off',
      'no-unused-vars': ['warn', { args: 'none', argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': 'off',
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
      'no-useless-catch': 'off',
      'no-fallthrough': 'off',
      'no-self-assign': 'off',
      'no-prototype-builtins': 'off'
    }
  }
];