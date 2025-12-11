// src/index.js - Export all modules

const { Agent } = require('./core/Agent');
const { Session } = require('./core/Session');
const { Compositor } = require('./core/Compositor');
const { LayoutNode, Container, Pane } = require('./layout/LayoutNode');
const { LayoutManager } = require('./layout/LayoutManager');
const { InputRouter } = require('./input/InputRouter');
const { IPCHub, IAC_DEFAULT_TEMPLATE } = require('./ipc/IPCHub');
const { TabBar } = require('./ui/TabBar');

module.exports = {
  // Core
  Agent,
  Session,
  Compositor,

  // Layout
  LayoutNode,
  Container,
  Pane,
  LayoutManager,

  // Input
  InputRouter,

  // IPC
  IPCHub,
  IAC_DEFAULT_TEMPLATE,

  // UI
  TabBar
};
