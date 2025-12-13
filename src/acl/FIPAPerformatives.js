// src/acl/FIPAPerformatives.js - FIPA ACL Performative Definitions
// Based on FIPA Communicative Act Library Specification (SC00037J)

/**
 * FIPA ACL Performatives - The "verbs" of agent communication
 *
 * Each performative carries specific semantic meaning about the sender's intent,
 * enabling receiving agents to respond appropriately.
 */

const Performatives = {
  // ═══════════════════════════════════════════════════════════════════════════
  // INFORMATIVE ACTS - Sharing information
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * INFORM - Tell the receiver that a proposition is true
   * Sender believes the proposition and intends receiver to also believe it
   *
   * Example: "The tests are passing" / "File X was modified"
   */
  INFORM: 'inform',

  /**
   * INFORM-IF - Answer a yes/no question
   * Response to QUERY-IF with the truth value
   *
   * Example: "Yes, the build is green" / "No, that function doesn't exist"
   */
  INFORM_IF: 'inform-if',

  /**
   * INFORM-REF - Provide a referent for a description
   * Response to QUERY-REF with the actual value
   *
   * Example: "The current branch is 'main'"
   */
  INFORM_REF: 'inform-ref',

  /**
   * CONFIRM - Confirm something the receiver is uncertain about
   * Strengthens receiver's belief in something they already suspect
   *
   * Example: "Yes, that's the correct approach"
   */
  CONFIRM: 'confirm',

  /**
   * DISCONFIRM - Disconfirm something the receiver believes
   * Corrects a mistaken belief
   *
   * Example: "Actually, that's not how the API works"
   */
  DISCONFIRM: 'disconfirm',

  // ═══════════════════════════════════════════════════════════════════════════
  // DIRECTIVE ACTS - Requesting action or information
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * REQUEST - Ask receiver to perform an action
   * Sender wants the action done and believes receiver can do it
   *
   * Example: "Run the test suite" / "Refactor this function"
   */
  REQUEST: 'request',

  /**
   * REQUEST-WHEN - Request action when condition becomes true
   * Conditional request with a trigger
   *
   * Example: "Notify me when the build completes"
   */
  REQUEST_WHEN: 'request-when',

  /**
   * REQUEST-WHENEVER - Request action every time condition is true
   * Standing request that triggers repeatedly
   *
   * Example: "Alert me whenever tests fail"
   */
  REQUEST_WHENEVER: 'request-whenever',

  /**
   * QUERY-IF - Ask if a proposition is true
   * Yes/no question expecting INFORM-IF response
   *
   * Example: "Does this code pass linting?" / "Is the server running?"
   */
  QUERY_IF: 'query-if',

  /**
   * QUERY-REF - Ask for the value matching a description
   * Expecting INFORM-REF response with the referent
   *
   * Example: "What's the current error count?" / "Which files import X?"
   */
  QUERY_REF: 'query-ref',

  // ═══════════════════════════════════════════════════════════════════════════
  // COMMISSIVE ACTS - Committing to actions
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * AGREE - Commit to performing a requested action
   * Response to REQUEST indicating intent to comply
   *
   * Example: "I'll run the tests now"
   */
  AGREE: 'agree',

  /**
   * REFUSE - Decline to perform a requested action
   * Response to REQUEST with reason for refusal
   *
   * Example: "I can't modify that file - it's read-only"
   */
  REFUSE: 'refuse',

  /**
   * CANCEL - Cancel a previous commitment
   * Withdraw from an earlier AGREE
   *
   * Example: "I need to cancel the code review - higher priority task"
   */
  CANCEL: 'cancel',

  // ═══════════════════════════════════════════════════════════════════════════
  // PROPOSITIVE ACTS - Negotiation and proposals
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * CFP - Call For Proposals
   * Initiate a negotiation by asking for proposals
   * Core of Contract-Net protocol
   *
   * Example: "Who can handle code review for PR #123?"
   */
  CFP: 'cfp',

  /**
   * PROPOSE - Submit a proposal in response to CFP
   * Offer to perform action under specified conditions
   *
   * Example: "I can review it with security focus, ETA 10 minutes"
   */
  PROPOSE: 'propose',

  /**
   * ACCEPT-PROPOSAL - Accept a proposal
   * Commit the proposer to the offered action
   *
   * Example: "Please proceed with your review approach"
   */
  ACCEPT_PROPOSAL: 'accept-proposal',

  /**
   * REJECT-PROPOSAL - Reject a proposal
   * Decline without counter-proposal
   *
   * Example: "Selected another agent for this task"
   */
  REJECT_PROPOSAL: 'reject-proposal',

  // ═══════════════════════════════════════════════════════════════════════════
  // META ACTS - Protocol management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * SUBSCRIBE - Request notifications about a condition
   * Establishes ongoing notification relationship
   *
   * Example: "Subscribe me to file change events in /src"
   */
  SUBSCRIBE: 'subscribe',

  /**
   * NOT-UNDERSTOOD - Signal message was not parseable/understandable
   * Protocol-level error response
   *
   * Example: "Could not parse your request"
   */
  NOT_UNDERSTOOD: 'not-understood',

  /**
   * FAILURE - Report that an action failed
   * Indicates attempted but unsuccessful action
   *
   * Example: "Tests failed with 3 errors"
   */
  FAILURE: 'failure',

  /**
   * PROPAGATE - Request to forward a message
   * Ask receiver to pass message to others
   */
  PROPAGATE: 'propagate',

  /**
   * PROXY - Request to forward and relay response
   * Intermediary pattern
   */
  PROXY: 'proxy',
};

/**
 * Semantic metadata for each performative
 * Helps LLMs understand appropriate responses
 */
const PerformativeSemantics = {
  [Performatives.INFORM]: {
    category: 'informative',
    description: 'Share factual information',
    expectedResponses: [], // No response required
    requiresContent: true,
  },
  [Performatives.INFORM_IF]: {
    category: 'informative',
    description: 'Answer a yes/no question',
    expectedResponses: [],
    requiresContent: true,
  },
  [Performatives.INFORM_REF]: {
    category: 'informative',
    description: 'Provide a referenced value',
    expectedResponses: [],
    requiresContent: true,
  },
  [Performatives.CONFIRM]: {
    category: 'informative',
    description: 'Confirm a belief',
    expectedResponses: [],
    requiresContent: true,
  },
  [Performatives.DISCONFIRM]: {
    category: 'informative',
    description: 'Correct a mistaken belief',
    expectedResponses: [],
    requiresContent: true,
  },
  [Performatives.REQUEST]: {
    category: 'directive',
    description: 'Request an action be performed',
    expectedResponses: [Performatives.AGREE, Performatives.REFUSE, Performatives.NOT_UNDERSTOOD],
    requiresContent: true,
  },
  [Performatives.REQUEST_WHEN]: {
    category: 'directive',
    description: 'Request action when condition is true',
    expectedResponses: [Performatives.AGREE, Performatives.REFUSE],
    requiresContent: true,
    requiresCondition: true,
  },
  [Performatives.REQUEST_WHENEVER]: {
    category: 'directive',
    description: 'Request action whenever condition is true',
    expectedResponses: [Performatives.AGREE, Performatives.REFUSE],
    requiresContent: true,
    requiresCondition: true,
  },
  [Performatives.QUERY_IF]: {
    category: 'directive',
    description: 'Ask a yes/no question',
    expectedResponses: [Performatives.INFORM_IF, Performatives.REFUSE, Performatives.NOT_UNDERSTOOD],
    requiresContent: true,
  },
  [Performatives.QUERY_REF]: {
    category: 'directive',
    description: 'Ask for a value',
    expectedResponses: [Performatives.INFORM_REF, Performatives.REFUSE, Performatives.NOT_UNDERSTOOD],
    requiresContent: true,
  },
  [Performatives.AGREE]: {
    category: 'commissive',
    description: 'Commit to perform requested action',
    expectedResponses: [Performatives.INFORM, Performatives.FAILURE],
    requiresContent: false,
    isResponse: true,
  },
  [Performatives.REFUSE]: {
    category: 'commissive',
    description: 'Decline to perform action',
    expectedResponses: [],
    requiresContent: true, // Reason for refusal
    isResponse: true,
  },
  [Performatives.CANCEL]: {
    category: 'commissive',
    description: 'Cancel previous commitment',
    expectedResponses: [],
    requiresContent: false,
  },
  [Performatives.CFP]: {
    category: 'propositive',
    description: 'Call for proposals - initiate negotiation',
    expectedResponses: [Performatives.PROPOSE, Performatives.REFUSE, Performatives.NOT_UNDERSTOOD],
    requiresContent: true,
    protocol: 'fipa-contract-net',
  },
  [Performatives.PROPOSE]: {
    category: 'propositive',
    description: 'Submit a proposal',
    expectedResponses: [Performatives.ACCEPT_PROPOSAL, Performatives.REJECT_PROPOSAL],
    requiresContent: true,
    isResponse: true,
    protocol: 'fipa-contract-net',
  },
  [Performatives.ACCEPT_PROPOSAL]: {
    category: 'propositive',
    description: 'Accept a proposal',
    expectedResponses: [Performatives.INFORM, Performatives.FAILURE],
    requiresContent: false,
    isResponse: true,
    protocol: 'fipa-contract-net',
  },
  [Performatives.REJECT_PROPOSAL]: {
    category: 'propositive',
    description: 'Reject a proposal',
    expectedResponses: [],
    requiresContent: false,
    isResponse: true,
    protocol: 'fipa-contract-net',
  },
  [Performatives.SUBSCRIBE]: {
    category: 'meta',
    description: 'Subscribe to notifications',
    expectedResponses: [Performatives.AGREE, Performatives.REFUSE],
    requiresContent: true,
  },
  [Performatives.NOT_UNDERSTOOD]: {
    category: 'meta',
    description: 'Signal message not understood',
    expectedResponses: [],
    requiresContent: true,
    isResponse: true,
  },
  [Performatives.FAILURE]: {
    category: 'meta',
    description: 'Report action failure',
    expectedResponses: [],
    requiresContent: true,
    isResponse: true,
  },
  [Performatives.PROPAGATE]: {
    category: 'meta',
    description: 'Request message forwarding',
    expectedResponses: [],
    requiresContent: true,
  },
  [Performatives.PROXY]: {
    category: 'meta',
    description: 'Request proxy forwarding with response relay',
    expectedResponses: [],
    requiresContent: true,
  },
};

/**
 * Get the semantic metadata for a performative
 * @param {string} performative
 * @returns {Object|null}
 */
function getSemantics(performative) {
  return PerformativeSemantics[performative] || null;
}

/**
 * Check if a performative is valid
 * @param {string} performative
 * @returns {boolean}
 */
function isValidPerformative(performative) {
  return Object.values(Performatives).includes(performative);
}

/**
 * Get appropriate response performatives
 * @param {string} performative
 * @returns {string[]}
 */
function getExpectedResponses(performative) {
  const semantics = getSemantics(performative);
  return semantics ? semantics.expectedResponses : [];
}

module.exports = {
  Performatives,
  PerformativeSemantics,
  getSemantics,
  isValidPerformative,
  getExpectedResponses,
};
