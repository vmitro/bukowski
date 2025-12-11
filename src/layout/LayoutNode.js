// src/layout/LayoutNode.js - Layout tree nodes

const crypto = require('crypto');

class LayoutNode {
  constructor() {
    this.id = crypto.randomUUID();
    this.parent = null;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
  }

  /** @returns {'container'|'pane'} */
  get type() { throw new Error('Abstract'); }

  toJSON() { throw new Error('Abstract'); }

  static fromJSON(data) {
    if (data.type === 'container') {
      return Container.fromJSON(data);
    } else if (data.type === 'pane') {
      return Pane.fromJSON(data);
    }
    throw new Error(`Unknown layout node type: ${data.type}`);
  }
}

class Container extends LayoutNode {
  constructor(orientation = 'horizontal', ratios = [0.5, 0.5]) {
    super();
    this.orientation = orientation; // 'horizontal' | 'vertical'
    this.ratios = ratios;           // [0.5, 0.5] for 50/50 split
    this.children = [];             // LayoutNode[]
  }

  get type() { return 'container'; }

  toJSON() {
    return {
      type: 'container',
      id: this.id,
      orientation: this.orientation,
      ratios: this.ratios,
      children: this.children.map(c => c.toJSON())
    };
  }

  static fromJSON(data) {
    const container = new Container(data.orientation, data.ratios);
    container.id = data.id;
    container.children = data.children.map(c => {
      const child = LayoutNode.fromJSON(c);
      child.parent = container;
      return child;
    });
    return container;
  }
}

class Pane extends LayoutNode {
  constructor(agentId) {
    super();
    this.agentId = agentId;  // Reference to Agent.id
    this.focused = false;
  }

  get type() { return 'pane'; }

  toJSON() {
    return {
      type: 'pane',
      id: this.id,
      agentId: this.agentId
    };
  }

  static fromJSON(data) {
    const pane = new Pane(data.agentId);
    pane.id = data.id;
    return pane;
  }
}

module.exports = { LayoutNode, Container, Pane };
