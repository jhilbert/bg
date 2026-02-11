const POINTS = 24;
const TOTAL_CHECKERS = 15;
const STORAGE_KEY = "bg-save";
const PROFILE_STORAGE_KEY = "bg-profile";
const AI_MOVE_TOTAL_MS = 3000;
const AI_MOVE_MIN_STEP_MS = 450;
const COMMIT_VERSION = "V2026-02-11-2";
const SIGNALING_BASE_URL = "https://bg-rendezvous.hilbert.workers.dev";
const SIGNALING_RECONNECT_BASE_MS = 700;
const SIGNALING_RECONNECT_MAX_MS = 8000;
const HOST_NEGOTIATION_RETRY_MS = 2600;
const HOST_DISCONNECT_GRACE_MS = 3500;
const RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const state = {
  board: Array(POINTS).fill(0),
  bar: { player: 0, ai: 0 },
  off: { player: 0, ai: 0 },
  turn: "player",
  dice: [],
  remainingDice: [],
  selectedFrom: null,
  message: "",
  awaitingRoll: false,
  aiMoveHighlights: { from: [], to: [] },
  lastMoveSnapshot: null,
  legalPointTargets: [],
  canBearOffSelection: false,
  allowedSelectionDice: [],
  openingRollPending: true,
  diceOwners: [],
  gameMode: "ai",
  localSide: "player",
  autoDiceEnabled: false,
  showNoMoveDice: false,
  localPlayerName: "",
  localClientId: "",
  playerNames: { player: "", ai: "" },
  nameClaimCandidate: "",
  nameUpdatePending: false,
  nameStatusMessage: "",
  nameStatusIsError: false,
  networkModalOpen: false,
  remoteSyncInProgress: false,
  lastSyncedPayload: "",
  lastSyncedStateFingerprint: "",
  syncSeq: 0,
  availableRooms: [],
  roomsLoading: false,
  roomsError: "",
  gameOver: false,
  winnerSide: "",
  resignedBySide: "",
  resignModalOpen: false,
};

const rtc = {
  pc: null,
  channel: null,
  role: null,
  connected: false,
  signalingSocket: null,
  signalingBaseUrl: "",
  signalingReconnectAttempts: 0,
  manualDisconnect: false,
  negotiationInFlight: false,
  queuedNegotiationIceRestart: false,
  queuedNegotiationReason: "",
  roomId: "",
  peerCount: 0,
  pendingRemoteCandidates: [],
  generatedSignal: "",
  autoRejoinInFlight: false,
  autoRejoinBlockedRoomId: "",
  autoRejoinBlockedUpdatedAt: 0,
};

let autoDiceRollTimer = null;
let roomListPollTimer = null;
let signalingReconnectTimer = null;
let hostNegotiationRetryTimer = null;
let hostDisconnectGraceTimer = null;

const elements = {
  topRow: document.getElementById("top-row"),
  bottomRow: document.getElementById("bottom-row"),
  board: document.getElementById("board"),
  dice: document.getElementById("dice"),
  turnLabel: document.getElementById("turn-label"),
  playerOff: document.getElementById("player-off"),
  aiOff: document.getElementById("ai-off"),
  subtitle: document.getElementById("subtitle"),
  playerTitle: document.getElementById("player-title"),
  opponentTitle: document.getElementById("opponent-title"),
  playerBar: document.getElementById("player-bar"),
  aiBar: document.getElementById("ai-bar"),
  playerPip: document.getElementById("player-pip"),
  aiPip: document.getElementById("ai-pip"),
  remainingDice: document.getElementById("remaining-dice"),
  playerOffFill: document.getElementById("player-off-fill"),
  aiOffFill: document.getElementById("ai-off-fill"),
  hint: document.getElementById("hint"),
  newGame: document.getElementById("new-game"),
  endTurn: document.getElementById("end-turn"),
  undoMove: document.getElementById("undo-move"),
  bearOff: document.getElementById("bear-off"),
  roomAction: document.getElementById("room-action"),
  autoDiceToggle: document.getElementById("auto-dice-toggle"),
  playerNameInput: document.getElementById("player-name-input"),
  updatePlayerName: document.getElementById("update-player-name"),
  claimPlayerName: document.getElementById("claim-player-name"),
  nameStatus: document.getElementById("name-status"),
  networkStatus: document.getElementById("network-status"),
  createRoom: document.getElementById("create-room"),
  refreshRooms: document.getElementById("refresh-rooms"),
  roomList: document.getElementById("room-list"),
  roomListEmpty: document.getElementById("room-list-empty"),
  roomsLoading: document.getElementById("rooms-loading"),
  roomsError: document.getElementById("rooms-error"),
  roomModal: document.getElementById("room-modal"),
  roomModalClose: document.getElementById("room-modal-close"),
  resignModal: document.getElementById("resign-modal"),
  resignModalClose: document.getElementById("resign-modal-close"),
  resignConfirm: document.getElementById("resign-confirm"),
  resignCancel: document.getElementById("resign-cancel"),
  commitVersion: document.getElementById("commit-version"),
};

function otherSide(side) {
  return side === "player" ? "ai" : "player";
}

function normalizePlayerName(rawValue) {
  return String(rawValue || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 22);
}

function normalizeClientId(rawValue) {
  return String(rawValue || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 64);
}

function createLocalClientId() {
  if (window.crypto?.randomUUID) {
    return normalizeClientId(window.crypto.randomUUID());
  }
  if (window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function saveProfileToStorage() {
  const payload = {
    localPlayerName: state.localPlayerName,
    localClientId: state.localClientId,
  };
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(payload));
}

function loadProfileFromStorage() {
  const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
  if (raw) {
    try {
      const payload = JSON.parse(raw);
      state.localPlayerName = normalizePlayerName(payload?.localPlayerName || "");
      state.localClientId = normalizeClientId(payload?.localClientId || "");
    } catch {
      state.localPlayerName = "";
      state.localClientId = "";
    }
  }
  if (!state.localClientId) {
    state.localClientId = createLocalClientId();
  }
  state.playerNames[state.localSide] = state.localPlayerName;
  saveProfileToStorage();
}

function ensureLocalClientId() {
  if (state.localClientId) return state.localClientId;
  state.localClientId = createLocalClientId();
  saveProfileToStorage();
  return state.localClientId;
}

function sideRoleName(side) {
  return side === "player" ? "Host" : "Guest";
}

function getPlayerName(side) {
  if (side !== "player" && side !== "ai") return "";
  return normalizePlayerName(state.playerNames[side] || "");
}

function sideIdentityLabel(side) {
  const customName = getPlayerName(side);
  return customName || sideRoleName(side);
}

function setLocalPlayerName(rawValue, { announce = false, sync = true } = {}) {
  const normalized = normalizePlayerName(rawValue);
  const side = state.localSide === "ai" ? "ai" : "player";
  const changed =
    state.localPlayerName !== normalized || getPlayerName(side) !== normalized;

  state.localPlayerName = normalized;
  state.playerNames[side] = normalized;
  saveProfileToStorage();

  if (!changed) return;
  clearNameClaimCandidate();
  setNameStatus("");

  if (announce) {
    state.message = normalized
      ? `Player name updated to ${normalized}.`
      : "Player name cleared. Using Host/Guest labels.";
  }
  render();
  if (state.gameMode === "p2p") {
    sendPlayerNameToSignaling();
    void fetchAvailableRooms({ silent: true });
  }
  if (sync) {
    syncGameStateToPeer(true);
  }
}

function sideLabel(side) {
  if (state.gameMode === "p2p") {
    return `Player (${sideIdentityLabel(side)})`;
  }
  return side === "player" ? "Player" : "Computer";
}

function sideBarLabel(side) {
  if (state.gameMode === "p2p") {
    const compactName = sideIdentityLabel(side).toUpperCase().slice(0, 14);
    return `PLAYER (${compactName}) BAR`;
  }
  return side === "player" ? "PLAYER BAR" : "AI BAR";
}

function sideCardLabel(side) {
  const baseLabel = sideLabel(side);
  if (state.gameMode === "p2p" && side === state.localSide) {
    return `${baseLabel} (You)`;
  }
  return baseLabel;
}

function capitalizeSide(side) {
  return sideLabel(side);
}

function isLocalTurn() {
  return state.turn === state.localSide;
}

function isAiControlledTurn() {
  return state.gameMode === "ai" && state.turn === "ai";
}

function canLocalRoll() {
  if (state.gameOver) return false;
  if (!state.awaitingRoll) return false;
  if (state.openingRollPending) return state.localSide === "player";
  return isLocalTurn();
}

function canStartNewGameLocally() {
  return state.gameMode !== "p2p" || state.localSide === "player";
}

function markGameOver({ winnerSide = "", resignedBySide = "", message = "" } = {}) {
  state.gameOver = true;
  state.winnerSide = winnerSide === "ai" || winnerSide === "player" ? winnerSide : "";
  state.resignedBySide = resignedBySide === "ai" || resignedBySide === "player"
    ? resignedBySide
    : "";
  state.selectedFrom = null;
  state.lastMoveSnapshot = null;
  state.awaitingRoll = false;
  state.remainingDice = [];
  state.diceOwners = [];
  state.showNoMoveDice = false;
  state.autoDiceEnabled = false;
  if (message) {
    state.message = message;
  }
}

function closeResignModal({ renderAfter = true } = {}) {
  if (!elements.resignModal) return;
  state.resignModalOpen = false;
  elements.resignModal.hidden = true;
  if (renderAfter) {
    render();
  }
}

function openResignModal() {
  if (!elements.resignModal || state.gameOver) return;
  state.resignModalOpen = true;
  elements.resignModal.hidden = false;
  if (elements.resignConfirm) {
    elements.resignConfirm.focus();
  }
  render();
}

function notifyPeerResigned() {
  if (state.gameMode !== "p2p") return;
  const payload = {
    type: "resign",
    side: state.localSide,
    name: state.localPlayerName,
  };
  if (rtc.channel && rtc.channel.readyState === "open") {
    rtc.channel.send(JSON.stringify(payload));
  }
  sendSignalPayload({
    kind: "resign",
    side: state.localSide,
    name: state.localPlayerName,
  });
}

function applyResignOutcome({
  resignedBySide,
  resignedByName = "",
  localInitiated = false,
} = {}) {
  const resignedSide = resignedBySide === "ai" ? "ai" : "player";
  const winner = otherSide(resignedSide);
  const normalizedName = normalizePlayerName(resignedByName);

  if (normalizedName) {
    state.playerNames[resignedSide] = normalizedName;
  }
  state.playerNames[state.localSide] = state.localPlayerName;

  const resignedLabel = normalizedName
    ? `Player (${normalizedName})`
    : sideLabel(resignedSide);
  const message = localInitiated
    ? `You resigned. ${capitalizeSide(winner)} wins! Press New Game to play again.`
    : `${resignedLabel} resigned. ${capitalizeSide(winner)} wins! Press New Game to play again.`;

  markGameOver({
    winnerSide: winner,
    resignedBySide: resignedSide,
    message,
  });
}

function handleRemoteResignNotice(payload = {}) {
  const resignedSide = payload.side === "ai" ? "ai" : "player";
  if (state.gameOver && state.resignedBySide === resignedSide) {
    return;
  }
  applyResignOutcome({
    resignedBySide: resignedSide,
    resignedByName: payload.name || "",
    localInitiated: false,
  });
  closeResignModal({ renderAfter: false });
  render();
}

function confirmResign() {
  if (state.gameOver) {
    closeResignModal();
    return;
  }
  applyResignOutcome({
    resignedBySide: state.localSide,
    resignedByName: state.localPlayerName,
    localInitiated: true,
  });
  closeResignModal({ renderAfter: false });
  notifyPeerResigned();
  syncGameStateToPeer(true);
  render();
}

function handlePrimaryGameAction() {
  if (state.gameOver) {
    if (!canStartNewGameLocally()) {
      state.message = "Only host can start a new network game.";
      render();
      return;
    }
    initBoard();
    return;
  }
  openResignModal();
}

function clearAutoDiceRollTimer() {
  if (autoDiceRollTimer) {
    clearTimeout(autoDiceRollTimer);
    autoDiceRollTimer = null;
  }
}

function maybeScheduleAutoDiceRoll() {
  const shouldAutoRoll = (
    state.gameMode === "p2p"
    && state.autoDiceEnabled
    && !state.networkModalOpen
    && canLocalRoll()
  );
  if (!shouldAutoRoll) {
    clearAutoDiceRollTimer();
    return;
  }
  if (autoDiceRollTimer) return;
  const delayMs = state.showNoMoveDice ? 1200 : 320;
  autoDiceRollTimer = setTimeout(() => {
    autoDiceRollTimer = null;
    if (
      state.gameMode !== "p2p"
      || !state.autoDiceEnabled
      || state.networkModalOpen
      || !canLocalRoll()
    ) {
      return;
    }
    rollForTurn();
  }, delayMs);
}

function initBoard() {
  state.board = Array(POINTS).fill(0);
  state.board[23] = 2;
  state.board[12] = 5;
  state.board[7] = 3;
  state.board[5] = 5;

  state.board[0] = -2;
  state.board[11] = -5;
  state.board[16] = -3;
  state.board[18] = -5;

  state.bar = { player: 0, ai: 0 };
  state.off = { player: 0, ai: 0 };
  state.turn = "player";
  state.selectedFrom = null;
  state.dice = [];
  state.remainingDice = [];
  state.awaitingRoll = true;
  state.aiMoveHighlights = { from: [], to: [] };
  state.lastMoveSnapshot = null;
  state.legalPointTargets = [];
  state.canBearOffSelection = false;
  state.allowedSelectionDice = [];
  state.openingRollPending = true;
  state.diceOwners = [];
  state.showNoMoveDice = false;
  state.gameOver = false;
  state.winnerSide = "";
  state.resignedBySide = "";
  state.playerNames[state.localSide] = state.localPlayerName;
  state.message = "Opening roll: click the dice to decide who starts.";
  state.lastSyncedPayload = "";
  state.lastSyncedStateFingerprint = "";
  closeResignModal({ renderAfter: false });
  render();
  syncGameStateToPeer();
}

function rollDie() {
  if (window.crypto && window.crypto.getRandomValues) {
    const array = new Uint32Array(1);
    window.crypto.getRandomValues(array);
    return (array[0] % 6) + 1;
  }
  return Math.floor(Math.random() * 6) + 1;
}

function rollForTurn() {
  if (state.gameMode === "p2p" && !canLocalRoll()) {
    return;
  }
  if (state.gameOver) {
    state.message = "Game is over. Start a new game.";
    render();
    return;
  }
  if (state.openingRollPending) {
    handleOpeningRoll();
    return;
  }

  state.showNoMoveDice = false;
  state.awaitingRoll = false;
  const die1 = rollDie();
  const die2 = rollDie();
  state.dice = die1 === die2 ? [die1, die1, die1, die1] : [die1, die2];
  state.remainingDice = [...state.dice];
  state.diceOwners = state.dice.map(() => state.turn);
  state.lastMoveSnapshot = createSnapshot(state);
  state.message = `${capitalizeSide(state.turn)} rolled ${state.dice.join(", ")}.`;
  render();

  if (!hasAnyLegalMoves(state, state.turn, state.remainingDice)) {
    const noBarEntryForPlayer =
      state.gameMode === "ai" && state.turn === "player" && state.bar.player > 0;
    const delayMs = noBarEntryForPlayer ? 5000 : 500;
    state.message = `${capitalizeSide(state.turn)} rolled ${state.dice.join(
      ", ",
    )} but has no legal moves. Turn passes.`;
    if (noBarEntryForPlayer) {
      state.message += " Checker on bar cannot enter. Computer will roll in 5 seconds.";
    }
    state.remainingDice = [];
    state.showNoMoveDice = true;
    state.lastMoveSnapshot = null;
    state.turn = otherSide(state.turn);
    state.awaitingRoll = true;
    render();
    syncGameStateToPeer();
    if (isAiControlledTurn()) {
      setTimeout(rollForTurn, delayMs);
    }
    return;
  }

  syncGameStateToPeer();
  if (isAiControlledTurn()) {
    setTimeout(runAiTurn, 500);
  }
}

function handleOpeningRoll() {
  state.showNoMoveDice = false;
  state.awaitingRoll = false;
  const playerDie = rollDie();
  const aiDie = rollDie();
  state.dice = [playerDie, aiDie];
  state.diceOwners = ["player", "ai"];

  if (playerDie === aiDie) {
    state.remainingDice = [];
    state.showNoMoveDice = false;
    state.message = `Opening roll tied at ${playerDie}. Roll again.`;
    state.awaitingRoll = true;
    render();
    syncGameStateToPeer();
    return;
  }

  const winner = playerDie > aiDie ? "player" : "ai";
  state.openingRollPending = false;
  state.turn = winner;
  state.remainingDice = [...state.dice];
  state.lastMoveSnapshot = createSnapshot(state);
  state.message = `Opening roll: ${sideLabel("player")} ${playerDie}, ${sideLabel("ai")} ${aiDie}. ${capitalizeSide(winner)} starts.`;
  render();
  syncGameStateToPeer();

  if (!hasAnyLegalMoves(state, winner, state.remainingDice)) {
    state.message += ` No legal opening moves. Turn passes to ${capitalizeSide(otherSide(winner))}.`;
    state.remainingDice = [];
    state.showNoMoveDice = true;
    state.lastMoveSnapshot = null;
    state.turn = otherSide(winner);
    state.awaitingRoll = true;
    render();
    syncGameStateToPeer();
    if (isAiControlledTurn()) {
      setTimeout(rollForTurn, 500);
    }
    return;
  }

  if (isAiControlledTurn()) {
    setTimeout(runAiTurn, 500);
  }
}

function updateSelectionHints() {
  state.legalPointTargets = [];
  state.canBearOffSelection = false;
  state.allowedSelectionDice = [];

  if (
    !isLocalTurn() ||
    state.awaitingRoll ||
    !state.selectedFrom ||
    state.remainingDice.length === 0
  ) {
    return;
  }

  const selectionMoves = getSelectionMoves(
    state,
    state.localSide,
    state.selectedFrom,
    state.remainingDice,
  );
  state.legalPointTargets = [
    ...new Set(
      selectionMoves
        .filter((move) => typeof move.to === "number")
        .map((move) => move.to),
    ),
  ];
  state.canBearOffSelection = selectionMoves.some((move) => move.to === "off");
  state.allowedSelectionDice = [...new Set(selectionMoves.map((move) => move.die))];
}

function openConnectionModal() {
  if (!elements.roomModal) return;
  state.networkModalOpen = true;
  elements.roomModal.hidden = false;
  if (state.gameMode !== "p2p") {
    state.message = "Rooms opened. Create or join a room.";
  }
  if (elements.playerNameInput && !state.localPlayerName) {
    elements.playerNameInput.focus();
  } else if (elements.createRoom) {
    elements.createRoom.focus();
  }
  startRoomListPolling();
  void fetchAvailableRooms();
  render();
}

function closeConnectionModal({ renderAfter = true } = {}) {
  if (!elements.roomModal) return;
  state.networkModalOpen = false;
  elements.roomModal.hidden = true;
  stopRoomListPolling();
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  requestAnimationFrame(() => {
    elements.dice?.focus({ preventScroll: true });
  });
  if (renderAfter) {
    render();
  }
}

function updateCheckerSize() {
  if (!elements.board) return;

  const samplePoint = elements.board.querySelector(".point");
  if (!(samplePoint instanceof HTMLElement)) return;

  const sampleStack = samplePoint.querySelector(".checker-stack");
  if (!(sampleStack instanceof HTMLElement)) return;

  const pointStyles = window.getComputedStyle(samplePoint);
  const stackStyles = window.getComputedStyle(sampleStack);
  const stackPad = Number.parseFloat(pointStyles.getPropertyValue("--stack-pad")) || 4;
  const stackGap = Number.parseFloat(stackStyles.rowGap || stackStyles.gap) ||
    Number.parseFloat(pointStyles.getPropertyValue("--stack-gap")) ||
    3;

  const stackRect = sampleStack.getBoundingClientRect();
  const availableHeight = stackRect.height - (stackPad * 2) - (stackGap * 4);
  const availableWidth = stackRect.width - 4;
  if (availableHeight <= 0 || availableWidth <= 0) return;

  const rawSize = Math.min(availableHeight / 5, availableWidth, 88);
  const checkerSize = Math.max(22, rawSize);
  elements.board.style.setProperty("--checker-size-px", `${checkerSize.toFixed(2)}px`);
}

function render() {
  updateSelectionHints();
  elements.topRow.innerHTML = "";
  elements.bottomRow.innerHTML = "";

  const topPoints = buildPointOrder("top");
  const bottomPoints = buildPointOrder("bottom");

  renderRow(elements.topRow, topPoints, "top");
  renderRow(elements.bottomRow, bottomPoints, "bottom");
  updateCheckerSize();

  renderDice();
  elements.turnLabel.textContent = state.openingRollPending
    ? "Opening Roll"
    : sideLabel(state.turn);
  if (elements.subtitle) {
    elements.subtitle.textContent =
      state.gameMode === "p2p" ? "Online peer-to-peer match" : "Single-player vs. the computer";
  }
  if (elements.playerTitle) {
    elements.playerTitle.textContent = sideCardLabel("player");
  }
  if (elements.opponentTitle) {
    elements.opponentTitle.textContent = sideCardLabel("ai");
  }
  elements.playerOff.textContent = state.off.player;
  elements.aiOff.textContent = state.off.ai;
  if (elements.playerBar) {
    elements.playerBar.textContent = state.bar.player;
  }
  if (elements.aiBar) {
    elements.aiBar.textContent = state.bar.ai;
  }
  if (elements.playerPip) {
    elements.playerPip.textContent = calculatePipCount(state, "player");
  }
  if (elements.aiPip) {
    elements.aiPip.textContent = calculatePipCount(state, "ai");
  }
  if (elements.remainingDice) {
    if (state.openingRollPending) {
      elements.remainingDice.textContent = "opening";
    } else {
      elements.remainingDice.textContent = `${state.remainingDice.length} left`;
    }
  }
  if (elements.playerOffFill) {
    elements.playerOffFill.style.width = `${(state.off.player / TOTAL_CHECKERS) * 100}%`;
  }
  if (elements.aiOffFill) {
    elements.aiOffFill.style.width = `${(state.off.ai / TOTAL_CHECKERS) * 100}%`;
  }
  elements.hint.textContent = state.message;
  if (elements.commitVersion) {
    elements.commitVersion.textContent = COMMIT_VERSION;
  }
  elements.dice.classList.toggle(
    "awaiting",
    canLocalRoll(),
  );
  elements.board.classList.toggle("player-turn", state.turn === "player");
  elements.board.classList.toggle("ai-turn", state.turn === "ai");

  if (elements.newGame) {
    if (state.gameOver) {
      elements.newGame.textContent = "New Game";
      const kbd = document.createElement("kbd");
      kbd.textContent = "N";
      elements.newGame.append(" ", kbd);
      elements.newGame.title = "Shortcut: N";
      elements.newGame.disabled = !canStartNewGameLocally();
    } else {
      elements.newGame.textContent = "Resign";
      const kbd = document.createElement("kbd");
      kbd.textContent = "N";
      elements.newGame.append(" ", kbd);
      elements.newGame.title = "Shortcut: N";
      elements.newGame.disabled = false;
    }
  }

  elements.undoMove.disabled =
    state.gameOver || !isLocalTurn() || state.awaitingRoll || !state.lastMoveSnapshot;
  elements.endTurn.disabled = state.gameOver || !isLocalTurn() || state.awaitingRoll;
  elements.bearOff.disabled =
    state.gameOver || !isLocalTurn() || state.awaitingRoll || !state.canBearOffSelection;
  if (elements.roomAction) {
    elements.roomAction.textContent = "Rooms";
    elements.roomAction.classList.remove("leave");
    elements.roomAction.setAttribute("aria-expanded", state.networkModalOpen ? "true" : "false");
  }
  if (elements.autoDiceToggle) {
    const showToggle = state.gameMode === "p2p";
    elements.autoDiceToggle.hidden = !showToggle;
    elements.autoDiceToggle.disabled = !showToggle || state.gameOver;
    elements.autoDiceToggle.classList.toggle("active", state.autoDiceEnabled);
    elements.autoDiceToggle.textContent = state.autoDiceEnabled
      ? "Auto dice: on"
      : "Auto dice: off";
    elements.autoDiceToggle.setAttribute(
      "aria-pressed",
      state.autoDiceEnabled ? "true" : "false",
    );
  }
  if (elements.playerNameInput) {
    const localRole = sideRoleName(state.localSide);
    elements.playerNameInput.placeholder = `Your name (${localRole})`;
    if (document.activeElement !== elements.playerNameInput) {
      const displayName = state.nameClaimCandidate || state.localPlayerName;
      if (elements.playerNameInput.value !== displayName) {
        elements.playerNameInput.value = displayName;
      }
    }
  }
  if (elements.updatePlayerName && elements.playerNameInput) {
    const pendingName = normalizePlayerName(elements.playerNameInput.value);
    elements.updatePlayerName.disabled = state.nameUpdatePending || pendingName === state.localPlayerName;
  }
  if (elements.claimPlayerName && elements.playerNameInput) {
    const pendingName = normalizePlayerName(elements.playerNameInput.value);
    const showClaim = Boolean(state.nameClaimCandidate)
      && state.nameClaimCandidate.toLowerCase() === pendingName.toLowerCase();
    elements.claimPlayerName.hidden = !showClaim;
    elements.claimPlayerName.disabled = state.nameUpdatePending || !showClaim;
  }
  if (elements.nameStatus) {
    const hasStatus = Boolean(state.nameStatusMessage);
    elements.nameStatus.hidden = !hasStatus;
    elements.nameStatus.textContent = hasStatus ? state.nameStatusMessage : "";
    elements.nameStatus.classList.toggle("error", hasStatus && state.nameStatusIsError);
  }
  if (elements.refreshRooms) {
    elements.refreshRooms.disabled = state.roomsLoading;
  }
  if (elements.createRoom) {
    const localPlayerInRoom = state.gameMode === "p2p" && Boolean(rtc.roomId);
    elements.createRoom.disabled = localPlayerInRoom;
    elements.createRoom.title = localPlayerInRoom
      ? "Leave your current room first."
      : "";
  }
  renderRoomList();
  if (elements.roomModal) {
    elements.roomModal.hidden = !state.networkModalOpen;
  }
  if (elements.resignModal) {
    elements.resignModal.hidden = !state.resignModalOpen;
  }
  updateNetworkStatus();
  maybeScheduleAutoDiceRoll();

  saveStateToStorage();
}

function buildPointOrder(row) {
  const points = [];
  if (row === "top") {
    for (let i = 12; i < 18; i += 1) points.push(i);
    points.push("bar");
    for (let i = 18; i < 24; i += 1) points.push(i);
  } else {
    for (let i = 11; i >= 6; i -= 1) points.push(i);
    points.push("bar");
    for (let i = 5; i >= 0; i -= 1) points.push(i);
  }
  return points;
}

function renderRow(container, points, row) {
  points.forEach((point) => {
    if (point === "bar") {
      const bar = document.createElement("div");
      bar.className = "bar";
      bar.dataset.bar = row === "top" ? "ai" : "player";
      if (
        state.selectedFrom &&
        state.selectedFrom.type === "bar" &&
        bar.dataset.bar === state.localSide
      ) {
        bar.classList.add("selected");
      }

      const label = document.createElement("div");
      label.textContent = sideBarLabel(row === "top" ? "ai" : "player");
      const stack = document.createElement("div");
      stack.className = "checker-stack";
      const count = row === "top" ? state.bar.ai : state.bar.player;
      const checkerClass = row === "top" ? "ai" : "player";

      for (let i = 0; i < Math.min(count, 5); i += 1) {
        const checker = document.createElement("div");
        checker.className = `checker ${checkerClass}`;
        stack.appendChild(checker);
      }
      if (count > 5) {
        const countLabel = document.createElement("div");
        countLabel.className = "count";
        countLabel.textContent = count;
        stack.appendChild(countLabel);
      }

      bar.appendChild(label);
      bar.appendChild(stack);
      container.appendChild(bar);
      return;
    }

    const pointDiv = document.createElement("div");
    pointDiv.className = "point";
    if ((point + 1) % 2 === 0) {
      pointDiv.classList.add("dark");
    }
    if (point <= 5) {
      pointDiv.classList.add("home-player");
    }
    if (point >= 18) {
      pointDiv.classList.add("home-ai");
    }
    pointDiv.dataset.index = point;
    if (state.selectedFrom && state.selectedFrom.type === "point" && state.selectedFrom.index === point) {
      pointDiv.classList.add("selected");
    }
    if (state.aiMoveHighlights.from.includes(point)) {
      pointDiv.classList.add("ai-move-from");
    }
    if (state.aiMoveHighlights.to.includes(point)) {
      pointDiv.classList.add("ai-move-to");
    }
    if (state.legalPointTargets.includes(point)) {
      pointDiv.classList.add("legal-target");
    }

    const numberLabel = document.createElement("div");
    numberLabel.className = "point-number";
    numberLabel.textContent = point + 1;
    pointDiv.appendChild(numberLabel);

    const stack = document.createElement("div");
    stack.className = "checker-stack";

    const count = state.board[point];
    const checkerClass = count > 0 ? "player" : "ai";
    const checkerCount = Math.abs(count);

    for (let i = 0; i < Math.min(checkerCount, 5); i += 1) {
      const checker = document.createElement("div");
      checker.className = `checker ${checkerClass}`;
      stack.appendChild(checker);
    }

    if (checkerCount > 5) {
      const countLabel = document.createElement("div");
      countLabel.className = "count";
      countLabel.textContent = checkerCount;
      pointDiv.appendChild(countLabel);
    }

    pointDiv.appendChild(stack);
    container.appendChild(pointDiv);
  });
}

function renderDice() {
  elements.dice.innerHTML = "";
  const showRollPrompt = canLocalRoll() && !state.showNoMoveDice;
  if (showRollPrompt) {
    const placeholder = document.createElement("div");
    placeholder.className = "die placeholder";
    placeholder.textContent = state.openingRollPending ? "Opening Roll" : "Roll";
    elements.dice.appendChild(placeholder);
    elements.dice.setAttribute(
      "aria-label",
      state.openingRollPending ? "Roll opening dice" : "Roll dice",
    );
    return;
  }
  const remainingCounts = state.remainingDice.reduce((acc, die) => {
    acc[die] = (acc[die] || 0) + 1;
    return acc;
  }, {});

  state.dice.forEach((die, index) => {
    const dieEl = document.createElement("div");
    dieEl.className = "die";
    const owner = state.diceOwners[index] || state.turn;
    if (!remainingCounts[die]) {
      dieEl.classList.add("used");
    } else {
      remainingCounts[die] -= 1;
    }
    if (
      state.selectedFrom &&
      isLocalTurn() &&
      !state.awaitingRoll &&
      state.allowedSelectionDice.length > 0 &&
      !state.allowedSelectionDice.includes(die)
    ) {
      dieEl.classList.add("unavailable");
    }
    if (owner === "player") dieEl.classList.add("player-die");
    if (owner === "ai") dieEl.classList.add("ai-die");
    dieEl.setAttribute("aria-label", `${capitalize(owner)} die ${die}`);
    dieEl.appendChild(createDieFace(die));
    elements.dice.appendChild(dieEl);
  });
  elements.dice.setAttribute("aria-label", `Dice: ${state.dice.join(", ")}`);
}

function createDieFace(value) {
  const face = document.createElement("div");
  face.className = "die-face";
  const activePips = {
    1: [5],
    2: [1, 9],
    3: [1, 5, 9],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9],
  };
  const pattern = activePips[value] || [];
  for (let i = 1; i <= 9; i += 1) {
    const pip = document.createElement("span");
    pip.className = "pip";
    if (pattern.includes(i)) {
      pip.classList.add("active");
    }
    face.appendChild(pip);
  }
  return face;
}

function handleBoardClick(event) {
  if (state.gameOver) return;
  if (!isLocalTurn()) return;
  if (state.awaitingRoll) {
    state.message = state.openingRollPending
      ? "Roll opening dice to decide who starts."
      : "Roll the dice to start your turn.";
    render();
    return;
  }
  const pointEl = event.target.closest(".point");
  const barEl = event.target.closest(".bar");
  const localSide = state.localSide;

  if (barEl && barEl.dataset.bar === localSide) {
    if (state.bar[localSide] > 0) {
      if (state.selectedFrom && state.selectedFrom.type === "bar") {
        state.selectedFrom = null;
        state.message = "Selection cleared.";
      } else {
        state.selectedFrom = { type: "bar" };
        state.message = "Selected checker from bar.";
      }
      render();
    }
    return;
  }

  if (!pointEl) return;
  const index = Number(pointEl.dataset.index);

  if (state.selectedFrom) {
    if (state.selectedFrom.type === "point" && state.selectedFrom.index === index) {
      state.selectedFrom = null;
      state.message = "Selection cleared.";
      render();
      return;
    }
    const move = findLegalMove(localSide, state.selectedFrom, { type: "point", index });
    if (move) {
      applyMove(state, localSide, move);
      consumeDie(move.die);
      state.selectedFrom = null;
      state.message = "Move made.";
      if (checkWin(localSide)) return;
      if (state.remainingDice.length === 0) endTurn();
      render();
      syncGameStateToPeer();
    } else {
      state.message = "That destination is not legal with your remaining dice.";
      render();
    }
    return;
  }

  if (state.bar[localSide] > 0) {
    state.message = "You must enter checkers from the bar first.";
    render();
    return;
  }

  const pointCount = state.board[index];
  const ownsPoint = (localSide === "player" && pointCount > 0) || (localSide === "ai" && pointCount < 0);
  if (ownsPoint) {
    state.selectedFrom = { type: "point", index };
    state.message = "Selected checker.";
    render();
  } else {
    state.message = "Select one of your checkers.";
    render();
  }
}

function consumeDie(die) {
  const idx = state.remainingDice.indexOf(die);
  if (idx >= 0) state.remainingDice.splice(idx, 1);
}

function handleBearOff() {
  if (state.gameOver) return;
  if (!isLocalTurn()) return;
  const localSide = state.localSide;
  if (state.awaitingRoll) {
    state.message = "Roll the dice before bearing off.";
    render();
    return;
  }
  if (!state.selectedFrom || state.selectedFrom.type !== "point") {
    state.message = "Select a checker to bear off.";
    render();
    return;
  }

  const move = findLegalMove(localSide, state.selectedFrom, { type: "off" });
  if (!move) {
    state.message = "No legal bear off with remaining dice.";
    render();
    return;
  }

  applyMove(state, localSide, move);
  consumeDie(move.die);
  state.selectedFrom = null;
  state.message = "Checker borne off.";
  if (checkWin(localSide)) return;
  if (state.remainingDice.length === 0) endTurn();
  render();
  syncGameStateToPeer();
}

function endTurn() {
  if (state.gameOver) return;
  if (!isLocalTurn()) return;
  if (state.awaitingRoll) {
    state.message = "Roll the dice before ending your turn.";
    render();
    return;
  }
  if (hasAnyLegalMoves(state, state.turn, state.remainingDice)) {
    state.message = "You must play all usable dice before ending your turn.";
    render();
    return;
  }
  state.selectedFrom = null;
  state.lastMoveSnapshot = null;
  state.showNoMoveDice = false;
  state.turn = otherSide(state.turn);
  state.dice = [];
  state.remainingDice = [];
  state.diceOwners = [];
  state.awaitingRoll = true;
  state.message = `${capitalizeSide(state.turn)} to roll.`;
  render();
  syncGameStateToPeer();
  if (isAiControlledTurn()) {
    setTimeout(rollForTurn, 500);
  }
}

function runAiTurn() {
  if (state.gameOver) return;
  if (state.gameMode !== "ai" || state.turn !== "ai") return;
  const sequences = generateMoveSequences(state, "ai", state.remainingDice);
  if (sequences.length === 0) {
    state.message = `AI rolled ${state.dice.join(", ")} but has no moves.`;
    state.aiMoveHighlights = { from: [], to: [] };
    startPlayerTurn();
    return;
  }

  const best = sequences.reduce((bestSeq, seq) => {
    const score = evaluateState(seq.state);
    if (!bestSeq || score > bestSeq.score) return { seq, score };
    return bestSeq;
  }, null);

  const bestMoves = best.seq.moves;
  const moveSummary = bestMoves.map((move) => formatMove(move)).join(", ");
  state.remainingDice = [];
  state.message = `AI rolled ${state.dice.join(", ")}.`;
  animateAiMoves(bestMoves, moveSummary);
}

function generateMoveSequences(currentState, player, dice) {
  const sequences = [];
  const diceOrders = getDiceOrders(dice);

  diceOrders.forEach((order) => {
    const usedSequences = [];
    recurseMoves(cloneState(currentState), player, order, [], usedSequences);
    sequences.push(...usedSequences);
  });

  if (sequences.length === 0) return [];

  const maxMoves = Math.max(...sequences.map((seq) => seq.moves.length));
  let filtered = sequences.filter((seq) => seq.moves.length === maxMoves);

  if (dice.length === 2 && dice[0] !== dice[1] && maxMoves === 1) {
    const high = Math.max(...dice);
    const hasHigh = filtered.some((seq) => seq.moves[0].die === high);
    if (hasHigh) {
      filtered = filtered.filter((seq) => seq.moves[0].die === high);
    }
  }

  return filtered;
}

function hasAnyLegalMoves(currentState, player, dice) {
  if (dice.length === 0) return false;
  return generateMoveSequences(currentState, player, dice).length > 0;
}

function recurseMoves(currentState, player, diceLeft, movesSoFar, sequences) {
  let anyMove = false;
  for (let i = 0; i < diceLeft.length; i += 1) {
    const die = diceLeft[i];
    const moves = getLegalMoves(currentState, player, die);
    if (moves.length === 0) continue;
    anyMove = true;
    moves.forEach((move) => {
      const nextState = cloneState(currentState);
      applyMove(nextState, player, move);
      const nextDice = diceLeft.slice();
      nextDice.splice(i, 1);
      recurseMoves(nextState, player, nextDice, movesSoFar.concat(move), sequences);
    });
  }

  if (!anyMove && movesSoFar.length > 0) {
    sequences.push({ moves: movesSoFar, state: currentState });
  }
}

function getDiceOrders(dice) {
  if (dice.length <= 1) return [dice];
  if (dice.length === 4) return [dice];
  const [a, b] = dice;
  if (a === b) return [dice];
  return [dice, [b, a]];
}

function getLegalMoves(currentState, player, die) {
  const moves = [];
  const dir = player === "player" ? -1 : 1;
  const opponent = player === "player" ? "ai" : "player";
  const barCount = currentState.bar[player];

  if (barCount > 0) {
    const entryIndex = player === "player" ? POINTS - die : die - 1;
    if (isPointOpen(currentState, opponent, entryIndex)) {
      moves.push({ from: "bar", to: entryIndex, die });
    }
    return moves;
  }

  for (let i = 0; i < POINTS; i += 1) {
    const count = currentState.board[i];
    if ((player === "player" && count <= 0) || (player === "ai" && count >= 0)) continue;

    const dest = i + dir * die;
    if (dest >= 0 && dest < POINTS) {
      if (isPointOpen(currentState, opponent, dest)) {
        moves.push({ from: i, to: dest, die });
      }
    } else if (canBearOff(currentState, player, i, die)) {
      moves.push({ from: i, to: "off", die });
    }
  }
  return moves;
}

function isPointOpen(currentState, opponent, index) {
  const count = currentState.board[index];
  if (opponent === "player") return count <= 1;
  return count >= -1;
}

function canBearOff(currentState, player, fromIndex, die) {
  if (!allCheckersInHome(currentState, player)) return false;
  const target = player === "player" ? fromIndex - die : fromIndex + die;
  if (player === "player" && fromIndex > 5) return false;
  if (player === "ai" && fromIndex < 18) return false;

  if (player === "player") {
    if (target === -1) return true;
    if (target < -1) {
      for (let i = fromIndex + 1; i <= 5; i += 1) {
        if (currentState.board[i] > 0) return false;
      }
      return true;
    }
  } else {
    if (target === 24) return true;
    if (target > 24) {
      for (let i = fromIndex - 1; i >= 18; i -= 1) {
        if (currentState.board[i] < 0) return false;
      }
      return true;
    }
  }
  return false;
}

function allCheckersInHome(currentState, player) {
  let count = 0;
  for (let i = 0; i < POINTS; i += 1) {
    const val = currentState.board[i];
    if (player === "player" && val > 0) {
      count += val;
      if (i > 5) return false;
    }
    if (player === "ai" && val < 0) {
      count += Math.abs(val);
      if (i < 18) return false;
    }
  }
  const barCount = currentState.bar[player];
  const offCount = currentState.off[player];
  return count + barCount + offCount === TOTAL_CHECKERS;
}

function applyMove(currentState, player, move) {
  const opponent = player === "player" ? "ai" : "player";

  if (move.from === "bar") {
    currentState.bar[player] -= 1;
  } else {
    currentState.board[move.from] += player === "player" ? -1 : 1;
  }

  if (move.to === "off") {
    currentState.off[player] += 1;
    return;
  }

  const destCount = currentState.board[move.to];
  if (player === "player" && destCount === -1) {
    currentState.board[move.to] = 0;
    currentState.bar[opponent] += 1;
  }
  if (player === "ai" && destCount === 1) {
    currentState.board[move.to] = 0;
    currentState.bar[opponent] += 1;
  }

  currentState.board[move.to] += player === "player" ? 1 : -1;
}

function findLegalMove(player, from, to) {
  const allowedMoves = getAllowedFirstMoves(state, player, state.remainingDice);
  const match = allowedMoves.find((move) => matchMove(move, from, to));
  if (match) return match;
  return null;
}

function matchMove(move, from, to) {
  if (move.from === "bar" && from.type !== "bar") return false;
  if (move.from !== "bar" && from.type !== "point") return false;
  if (from.type === "point" && move.from !== from.index) return false;
  if (to.type === "point" && move.to !== to.index) return false;
  if (to.type === "off" && move.to !== "off") return false;
  return true;
}

function getAllowedFirstMoves(currentState, player, dice) {
  const sequences = generateMoveSequences(currentState, player, dice);
  if (sequences.length === 0) return [];
  return sequences.map((seq) => seq.moves[0]).filter(Boolean);
}

function getSelectionMoves(currentState, player, from, dice) {
  return getAllowedFirstMoves(currentState, player, dice).filter((move) => {
    if (from.type === "bar") return move.from === "bar";
    return move.from === from.index;
  });
}

function calculatePipCount(currentState, player) {
  let total = 0;
  for (let i = 0; i < POINTS; i += 1) {
    const count = currentState.board[i];
    if (player === "player" && count > 0) {
      total += count * (i + 1);
    }
    if (player === "ai" && count < 0) {
      total += Math.abs(count) * (POINTS - i);
    }
  }
  const barCount = currentState.bar[player];
  if (barCount > 0) {
    total += barCount * (POINTS + 1);
  }
  return total;
}

function countMadePoints(currentState, player, startIndex, endIndex) {
  let count = 0;
  for (let i = startIndex; i <= endIndex; i += 1) {
    const value = currentState.board[i];
    if (player === "player" && value >= 2) count += 1;
    if (player === "ai" && value <= -2) count += 1;
  }
  return count;
}

function longestPrime(currentState, player) {
  let best = 0;
  let current = 0;
  for (let i = 0; i < POINTS; i += 1) {
    const value = currentState.board[i];
    const isPoint =
      (player === "player" && value >= 2) || (player === "ai" && value <= -2);
    if (isPoint) {
      current += 1;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }
  return best;
}

function countBlots(currentState, player) {
  let count = 0;
  for (let i = 0; i < POINTS; i += 1) {
    const value = currentState.board[i];
    if (player === "player" && value === 1) count += 1;
    if (player === "ai" && value === -1) count += 1;
  }
  return count;
}

function countVulnerableBlots(currentState, player) {
  let count = 0;
  for (let i = 0; i < POINTS; i += 1) {
    const value = currentState.board[i];
    if (player === "ai" && value === -1) {
      const maxIndex = Math.min(POINTS - 1, i + 6);
      for (let j = i + 1; j <= maxIndex; j += 1) {
        if (currentState.board[j] > 0) {
          count += 1;
          break;
        }
      }
    }
    if (player === "player" && value === 1) {
      const minIndex = Math.max(0, i - 6);
      for (let j = i - 1; j >= minIndex; j -= 1) {
        if (currentState.board[j] < 0) {
          count += 1;
          break;
        }
      }
    }
  }
  return count;
}

function evaluateState(currentState) {
  const aiOffScore = currentState.off.ai * 120;
  const playerOffScore = currentState.off.player * -120;
  const barScore = currentState.bar.player * 15 - currentState.bar.ai * 20;
  const aiPip = calculatePipCount(currentState, "ai");
  const playerPip = calculatePipCount(currentState, "player");
  const pipScore = (playerPip - aiPip) * 1.5;
  const aiHomePoints = countMadePoints(currentState, "ai", 18, 23);
  const playerHomePoints = countMadePoints(currentState, "player", 0, 5);
  const homeBoardScore = aiHomePoints * 4 - playerHomePoints * 3;
  const aiPrime = longestPrime(currentState, "ai");
  const playerPrime = longestPrime(currentState, "player");
  const primeScore = aiPrime * 8 - playerPrime * 6;
  const aiBlots = countBlots(currentState, "ai");
  const playerBlots = countBlots(currentState, "player");
  const blotScore = playerBlots * 5 - aiBlots * 7;
  const aiVulnerable = countVulnerableBlots(currentState, "ai");
  const playerVulnerable = countVulnerableBlots(currentState, "player");
  const vulnerabilityScore = playerVulnerable * 6 - aiVulnerable * 10;

  return (
    aiOffScore +
    playerOffScore +
    barScore +
    pipScore +
    homeBoardScore +
    primeScore +
    blotScore +
    vulnerabilityScore
  );
}

function checkWin(player) {
  if (state.off[player] >= TOTAL_CHECKERS) {
    markGameOver({
      winnerSide: player,
      message: `${capitalizeSide(player)} wins! Press New Game to play again.`,
    });
    render();
    syncGameStateToPeer();
    return true;
  }
  return false;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatMove(move) {
  const from = move.from === "bar" ? "bar" : `point ${move.from + 1}`;
  const to = move.to === "off" ? "off" : `point ${move.to + 1}`;
  return `${from} → ${to} (${move.die})`;
}

function startPlayerTurn() {
  if (state.gameOver) return;
  state.turn = "player";
  state.openingRollPending = false;
  state.selectedFrom = null;
  state.dice = [];
  state.remainingDice = [];
  state.diceOwners = [];
  state.showNoMoveDice = false;
  state.awaitingRoll = true;
  state.lastMoveSnapshot = null;
  state.message += ` ${capitalizeSide("player")} to roll.`;
  render();
  syncGameStateToPeer();
}

function cloneState(currentState) {
  return {
    board: [...currentState.board],
    bar: { ...currentState.bar },
    off: { ...currentState.off },
    turn: currentState.turn,
    dice: [...currentState.dice],
    remainingDice: [...currentState.remainingDice],
    awaitingRoll: currentState.awaitingRoll,
  };
}

function createSnapshot(currentState) {
  return {
    board: [...currentState.board],
    bar: { ...currentState.bar },
    off: { ...currentState.off },
    dice: [...currentState.dice],
    remainingDice: [...currentState.remainingDice],
    diceOwners: [...currentState.diceOwners],
    awaitingRoll: currentState.awaitingRoll,
    showNoMoveDice: currentState.showNoMoveDice === true,
  };
}

function restoreSnapshot(snapshot) {
  state.board = [...snapshot.board];
  state.bar = { ...snapshot.bar };
  state.off = { ...snapshot.off };
  state.dice = [...snapshot.dice];
  state.remainingDice = [...snapshot.remainingDice];
  state.diceOwners = Array.isArray(snapshot.diceOwners)
    ? [...snapshot.diceOwners]
    : state.dice.map(() => state.turn);
  state.awaitingRoll = snapshot.awaitingRoll;
  state.showNoMoveDice = snapshot.showNoMoveDice === true;
  state.selectedFrom = null;
  state.aiMoveHighlights = { from: [], to: [] };
}

function animateAiMoves(moves, moveSummary) {
  if (moves.length === 0) return;
  const stepDelay = Math.max(
    AI_MOVE_MIN_STEP_MS,
    Math.floor(AI_MOVE_TOTAL_MS / moves.length),
  );
  let index = 0;

  const applyNextMove = () => {
    if (state.gameOver) {
      state.aiMoveHighlights = { from: [], to: [] };
      render();
      return;
    }
    if (index >= moves.length) {
      state.aiMoveHighlights = { from: [], to: [] };
      state.message = `AI rolled ${state.dice.join(", ")}. Moves: ${moveSummary}.`;
      render();
      if (checkWin("ai")) return;
      startPlayerTurn();
      return;
    }
    const move = moves[index];
    applyMove(state, "ai", move);
    state.aiMoveHighlights = {
      from: typeof move.from === "number" ? [move.from] : [],
      to: typeof move.to === "number" ? [move.to] : [],
    };
    render();
    index += 1;
    setTimeout(applyNextMove, stepDelay);
  };

  applyNextMove();
}

function saveStateToStorage() {
  const payload = {
    board: state.board,
    bar: state.bar,
    off: state.off,
    turn: state.turn,
    gameMode: state.gameMode,
    localSide: state.localSide,
    dice: state.dice,
    diceOwners: state.diceOwners,
    remainingDice: state.remainingDice,
    awaitingRoll: state.awaitingRoll,
    openingRollPending: state.openingRollPending,
    showNoMoveDice: state.showNoMoveDice === true,
    gameOver: state.gameOver === true,
    winnerSide: state.winnerSide,
    resignedBySide: state.resignedBySide,
    syncSeq: state.syncSeq,
    localPlayerName: state.localPlayerName,
    playerNames: {
      player: getPlayerName("player"),
      ai: getPlayerName("ai"),
    },
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function loadStateFromStorage() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    state.message = "No saved game found.";
    render();
    return;
  }
  const payload = JSON.parse(saved);
  state.board = payload.board;
  state.bar = payload.bar;
  state.off = payload.off;
  state.turn = payload.turn;
  state.gameMode = payload.gameMode === "p2p" ? "p2p" : "ai";
  state.localSide = payload.localSide === "ai" ? "ai" : "player";
  state.dice = payload.dice;
  state.diceOwners = Array.isArray(payload.diceOwners)
    ? payload.diceOwners
    : payload.dice.map(() => payload.turn || "player");
  state.remainingDice = payload.remainingDice;
  state.awaitingRoll =
    payload.awaitingRoll ?? (state.remainingDice.length === 0);
  state.openingRollPending = payload.openingRollPending === true;
  state.showNoMoveDice = payload.showNoMoveDice === true;
  state.gameOver = payload.gameOver === true;
  state.winnerSide = payload.winnerSide === "ai" || payload.winnerSide === "player"
    ? payload.winnerSide
    : "";
  state.resignedBySide = payload.resignedBySide === "ai" || payload.resignedBySide === "player"
    ? payload.resignedBySide
    : "";
  state.syncSeq = normalizeSyncSeq(payload.syncSeq) ?? 0;
  state.localPlayerName = normalizePlayerName(
    payload.localPlayerName || state.localPlayerName,
  );
  const savedNames = payload.playerNames && typeof payload.playerNames === "object"
    ? payload.playerNames
    : {};
  state.playerNames = {
    player: normalizePlayerName(savedNames.player || state.playerNames.player),
    ai: normalizePlayerName(savedNames.ai || state.playerNames.ai),
  };
  state.playerNames[state.localSide] = state.localPlayerName;
  state.selectedFrom = null;
  state.message = "Loaded saved game.";
  state.lastMoveSnapshot = null;
  state.lastSyncedPayload = "";
  state.lastSyncedStateFingerprint = buildSyncStateFingerprint(state);
  render();
  syncGameStateToPeer();
}

function updateNetworkStatus(forcedMessage) {
  if (!elements.networkStatus) return;
  if (state.gameMode !== "p2p") {
    elements.networkStatus.textContent = "Not connected.";
    return;
  }
  if (forcedMessage) {
    elements.networkStatus.textContent = forcedMessage;
    return;
  }
  const roomPrefix = rtc.roomId ? `Room ${rtc.roomId}. ` : "";
  if (rtc.connected) {
    elements.networkStatus.textContent = isSignalingOpen()
      ? `${roomPrefix}Connected. You are ${sideLabel(state.localSide)}.`
      : `${roomPrefix}Peer connected. Reconnecting signaling...`;
    return;
  }
  if (rtc.signalingSocket && rtc.signalingSocket.readyState === WebSocket.OPEN) {
    if (!rtc.role) {
      elements.networkStatus.textContent = `${roomPrefix}Connected to signaling. Waiting for role assignment...`;
      return;
    }
    if (rtc.role === "host") {
      elements.networkStatus.textContent = rtc.peerCount > 1
        ? `${roomPrefix}${sideLabel("ai")} joined. Negotiating WebRTC...`
        : `${roomPrefix}You are ${sideLabel("player")}. Waiting for ${sideLabel("ai")}.`;
      return;
    }
    elements.networkStatus.textContent = `${roomPrefix}You are ${sideLabel("ai")}. Waiting for ${sideLabel("player")} offer...`;
    return;
  }
  if (rtc.roomId) {
    elements.networkStatus.textContent = rtc.connected
      ? `${roomPrefix}Peer connected. Reconnecting signaling...`
      : `${roomPrefix}Signaling disconnected. Reconnecting...`;
    return;
  }
  elements.networkStatus.textContent = "No active room.";
}

function normalizeSignalingBaseUrl(rawValue) {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(candidate);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Signaling URL must use http:// or https://.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function getSignalingBaseUrl() {
  const normalized = normalizeSignalingBaseUrl(SIGNALING_BASE_URL);
  if (!normalized) {
    throw new Error("Signaling service URL is not configured.");
  }
  return normalized;
}

function getRoomsEndpointUrl(baseUrl) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/rooms`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function getNameEndpointUrl(baseUrl, playerName) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/names/${encodeURIComponent(playerName)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function clearNameClaimCandidate() {
  state.nameClaimCandidate = "";
}

function setNameStatus(message = "", { isError = false } = {}) {
  state.nameStatusMessage = String(message || "");
  state.nameStatusIsError = isError === true;
}

async function reservePlayerName(playerName, { claim = false } = {}) {
  const normalizedName = normalizePlayerName(playerName);
  if (!normalizedName) {
    return { ok: true, name: "", claimed: false };
  }
  const baseUrl = getSignalingBaseUrl();
  const endpoint = getNameEndpointUrl(baseUrl, normalizedName);
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      clientId: ensureLocalClientId(),
      roomId: rtc.roomId,
      claim: claim === true,
    }),
    cache: "no-store",
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (response.status === 409) {
    return {
      ok: false,
      reason: payload?.reason || "taken",
      name: normalizePlayerName(payload?.name || normalizedName),
    };
  }
  if (!response.ok) {
    const message = typeof payload?.error === "string"
      ? payload.error
      : `Could not update name (${response.status}).`;
    throw new Error(message);
  }
  return {
    ok: true,
    name: normalizePlayerName(payload?.name || normalizedName),
    claimed: payload?.claimed === true,
  };
}

async function releasePlayerName(playerName, { strict = false } = {}) {
  const normalizedName = normalizePlayerName(playerName);
  if (!normalizedName) return true;
  const baseUrl = getSignalingBaseUrl();
  const endpoint = new URL(getNameEndpointUrl(baseUrl, normalizedName));
  endpoint.searchParams.set("client", ensureLocalClientId());
  const response = await fetch(endpoint.toString(), {
    method: "DELETE",
    cache: "no-store",
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (response.ok) {
    return true;
  }
  const reason = String(payload?.reason || "");
  if (!strict && (response.status === 409 || reason === "not-owner")) {
    return false;
  }
  const message = typeof payload?.error === "string" && payload.error
    ? payload.error
    : `Could not release name (${response.status}).`;
  throw new Error(message);
}

async function submitPlayerNameUpdate({ claim = false, announce = true } = {}) {
  if (state.nameUpdatePending) return;
  const nextName = normalizePlayerName(elements.playerNameInput?.value || "");
  const previousName = state.localPlayerName;
  setNameStatus("");

  if (!claim && nextName === previousName) {
    if (announce && nextName) {
      setNameStatus(`Current name: ${nextName}.`);
      render();
    }
    return;
  }

  state.nameUpdatePending = true;
  render();

  try {
    if (!nextName) {
      if (previousName) {
        await releasePlayerName(previousName);
      }
      clearNameClaimCandidate();
      setNameStatus("");
      setLocalPlayerName("", { announce, sync: true });
      return;
    }

    const reservation = await reservePlayerName(nextName, { claim });
    if (!reservation.ok) {
      const conflictingName = normalizePlayerName(reservation.name || nextName);
      state.nameClaimCandidate = conflictingName;
      if (elements.playerNameInput) {
        elements.playerNameInput.value = conflictingName;
      }
      setNameStatus("Name is already taken. Click Claim My Name to take it over.", { isError: true });
      render();
      return;
    }

    const reservedName = normalizePlayerName(reservation.name || nextName);
    if (
      previousName
      && previousName.toLowerCase() !== reservedName.toLowerCase()
    ) {
      await releasePlayerName(previousName);
    }
    clearNameClaimCandidate();
    setLocalPlayerName(reservedName, { announce, sync: true });
    if (claim && state.gameMode === "p2p") {
      sendPlayerNameToSignaling({ name: reservedName, claim: true });
      void fetchAvailableRooms({ silent: true });
    }
    if (reservation.claimed) {
      setNameStatus(`You claimed "${reservedName}".`);
      state.message = `You claimed the name ${reservedName}.`;
      render();
    }
  } catch (error) {
    setNameStatus(error?.message || "Failed to update player name.", { isError: true });
    state.message = error?.message || "Failed to update player name.";
    render();
  } finally {
    state.nameUpdatePending = false;
    render();
  }
}

function normalizeRoomRoster(players) {
  if (!Array.isArray(players)) return [];
  const seenRoles = new Set();
  const normalized = [];
  for (const player of players) {
    if (!player || typeof player !== "object") continue;
    const role = player.role === "guest" ? "guest" : "host";
    if (seenRoles.has(role)) continue;
    seenRoles.add(role);
    normalized.push({
      role,
      name: normalizePlayerName(player.name || ""),
    });
  }
  normalized.sort((left, right) => {
    if (left.role === right.role) return 0;
    return left.role === "host" ? -1 : 1;
  });
  return normalized.slice(0, 2);
}

function normalizeRoomDirectory(payload) {
  if (!payload || !Array.isArray(payload.rooms)) return [];
  const normalizedRooms = payload.rooms
    .map((room) => {
      if (!room || typeof room !== "object") return null;
      const roomId = normalizeRoomCode(room.roomId || "");
      if (!roomId) return null;
      const players = normalizeRoomRoster(room.players);
      const rawCount = Number.isFinite(room.playerCount) ? room.playerCount : players.length;
      const playerCount = Math.min(2, Math.max(players.length, rawCount, 0));
      if (playerCount < 1) return null;
      const updatedAt = Number.isFinite(room.updatedAt) ? room.updatedAt : 0;
      const occupiedRoles = new Set(players.map((player) => player.role));
      const openRole = playerCount < 2
        ? (occupiedRoles.has("host") ? "guest" : "host")
        : "";
      return {
        roomId,
        players,
        playerCount,
        openSeat: playerCount === 1,
        openRole,
        updatedAt,
      };
    })
    .filter(Boolean);

  normalizedRooms.sort((left, right) => {
    const updatedDelta = right.updatedAt - left.updatedAt;
    if (updatedDelta !== 0) return updatedDelta;
    return left.roomId.localeCompare(right.roomId);
  });
  return normalizedRooms;
}

function findAutoRejoinRoom(
  rooms,
  { excludedRoomId = "", excludedUpdatedAt = 0 } = {},
) {
  const localName = normalizePlayerName(state.localPlayerName);
  if (!localName || !Array.isArray(rooms)) return null;
  for (const room of rooms) {
    if (!room || room.playerCount !== 1 || !Array.isArray(room.players)) continue;
    if (room.roomId === excludedRoomId && room.updatedAt === excludedUpdatedAt) continue;
    const hasExactNameMatch = room.players.some((player) => {
      const playerName = normalizePlayerName(player?.name || "");
      return playerName === localName;
    });
    if (hasExactNameMatch) {
      return room;
    }
  }
  return null;
}

async function maybeAutoRejoinRoom(rooms) {
  if (rtc.autoRejoinInFlight) return;
  if (rtc.manualDisconnect) return;
  if (state.gameMode === "p2p" && rtc.roomId) return;
  if (isSignalingOpen() || isSignalingConnecting()) return;

  const candidateRoom = findAutoRejoinRoom(rooms, {
    excludedRoomId: rtc.autoRejoinBlockedRoomId,
    excludedUpdatedAt: rtc.autoRejoinBlockedUpdatedAt,
  });
  if (!candidateRoom) return;

  const blockedUpdatedAt = Number.isFinite(candidateRoom.updatedAt) ? candidateRoom.updatedAt : 0;
  rtc.autoRejoinInFlight = true;
  state.message = `Rejoining room ${candidateRoom.roomId}...`;
  render();
  try {
    await connectToRoom(candidateRoom.roomId);
    rtc.autoRejoinBlockedRoomId = "";
    rtc.autoRejoinBlockedUpdatedAt = 0;
  } catch (error) {
    rtc.autoRejoinBlockedRoomId = candidateRoom.roomId;
    rtc.autoRejoinBlockedUpdatedAt = blockedUpdatedAt;
    state.message = error?.message || `Failed to rejoin room ${candidateRoom.roomId}.`;
    render();
  } finally {
    rtc.autoRejoinInFlight = false;
  }
}

function roomRoleLabel(role) {
  return role === "guest" ? "Guest" : "Host";
}

function roleBoardColorLabel(role) {
  return role === "host" ? "Brown" : "Blue";
}

function roomPlayerDisplayName(player) {
  const customName = normalizePlayerName(player?.name || "");
  if (customName) return customName;
  return roomRoleLabel(player?.role);
}

function applyRoomRoster(players) {
  if (!Array.isArray(players)) return;
  const bySide = { player: "", ai: "" };
  for (const player of normalizeRoomRoster(players)) {
    const side = player.role === "guest" ? "ai" : "player";
    bySide[side] = normalizePlayerName(player.name || "");
  }
  bySide[state.localSide] = state.localPlayerName;
  state.playerNames.player = bySide.player;
  state.playerNames.ai = bySide.ai;
}

async function fetchAvailableRooms({ silent = false } = {}) {
  let baseUrl;
  try {
    baseUrl = getSignalingBaseUrl();
  } catch (error) {
    if (!silent) {
      state.roomsError = error.message || "Signaling service URL is not configured.";
      state.roomsLoading = false;
      render();
    }
    return;
  }

  if (!silent) {
    state.roomsLoading = true;
    state.roomsError = "";
    render();
  }

  const endpoint = new URL(getRoomsEndpointUrl(baseUrl));
  endpoint.searchParams.set("t", Date.now().toString(36));

  try {
    const response = await fetch(endpoint.toString(), {
      method: "GET",
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Failed to load rooms (${response.status}).`);
    }
    const payload = await response.json();
    if (!Array.isArray(payload?.rooms)) {
      throw new Error("Signaling service missing /rooms support. Deploy latest cloudflare worker.");
    }
    state.availableRooms = normalizeRoomDirectory(payload);
    state.roomsError = "";
    await maybeAutoRejoinRoom(state.availableRooms);
  } catch (error) {
    if (!silent) {
      state.roomsError = error.message || "Failed to load rooms.";
    }
  } finally {
    state.roomsLoading = false;
    render();
  }
}

function startRoomListPolling() {
  if (roomListPollTimer) return;
  roomListPollTimer = setInterval(() => {
    if (!state.networkModalOpen) {
      stopRoomListPolling();
      return;
    }
    void fetchAvailableRooms({ silent: true });
  }, 5000);
}

function stopRoomListPolling() {
  if (!roomListPollTimer) return;
  clearInterval(roomListPollTimer);
  roomListPollTimer = null;
}

function renderRoomList() {
  if (!elements.roomList) return;
  const rooms = Array.isArray(state.availableRooms) ? [...state.availableRooms] : [];
  const hasCurrentRoomEntry = rooms.some((room) => room.roomId === rtc.roomId);
  if (state.gameMode === "p2p" && rtc.roomId && !hasCurrentRoomEntry) {
    const localRole = state.localSide === "player" ? "host" : "guest";
    const remoteRole = localRole === "host" ? "guest" : "host";
    const players = [{ role: localRole, name: state.localPlayerName }];
    const remoteName = normalizePlayerName(state.playerNames[otherSide(state.localSide)] || "");
    const estimatedPeerCount = Number.isFinite(rtc.peerCount) ? rtc.peerCount : 1;
    if (estimatedPeerCount > 1 || remoteName) {
      players.push({ role: remoteRole, name: remoteName });
    }
    rooms.unshift({
      roomId: rtc.roomId,
      players,
      playerCount: players.length,
      openSeat: players.length < 2,
      openRole: players.some((player) => player.role === "host") ? "guest" : "host",
      updatedAt: Date.now(),
    });
  }
  elements.roomList.innerHTML = "";

  if (elements.roomsLoading) {
    elements.roomsLoading.hidden = !state.roomsLoading;
  }

  if (elements.roomsError) {
    const hasError = Boolean(state.roomsError);
    elements.roomsError.hidden = !hasError;
    elements.roomsError.textContent = hasError ? state.roomsError : "";
  }

  for (const room of rooms) {
    const roomCard = document.createElement("li");
    roomCard.className = "room-list-item";
    roomCard.dataset.roomId = room.roomId;

    const roomMain = document.createElement("div");
    roomMain.className = "room-list-main";

    const roomIdLine = document.createElement("p");
    roomIdLine.className = "room-id-line";
    const roomIdLabel = document.createElement("strong");
    roomIdLabel.className = "room-id-code";
    roomIdLabel.textContent = room.roomId;
    roomIdLine.append("Room", roomIdLabel);
    roomMain.appendChild(roomIdLine);

    const playerList = document.createElement("div");
    playerList.className = "room-player-list";
    for (const player of room.players) {
      const tag = document.createElement("span");
      tag.className = "room-player-tag";
      tag.textContent = roomPlayerDisplayName(player);
      playerList.appendChild(tag);
    }
    if (room.playerCount < 2) {
      const openSeatTag = document.createElement("span");
      openSeatTag.className = "room-player-tag room-open-seat";
      const openRole = room.openRole === "host" ? "host" : "guest";
      openSeatTag.textContent = `${roleBoardColorLabel(openRole)} side open`;
      playerList.appendChild(openSeatTag);
    }
    roomMain.appendChild(playerList);

    const stateLine = document.createElement("p");
    stateLine.className = "room-state-line";
    stateLine.textContent = `${room.playerCount}/2 players`;
    roomMain.appendChild(stateLine);

    const isCurrentRoom = state.gameMode === "p2p" && rtc.roomId === room.roomId;
    if (isCurrentRoom) {
      const currentTag = document.createElement("span");
      currentTag.className = "room-current-tag";
      currentTag.textContent = "Current room";
      roomMain.appendChild(currentTag);
    }

    roomCard.appendChild(roomMain);

    if (isCurrentRoom) {
      const leaveButton = document.createElement("button");
      leaveButton.type = "button";
      leaveButton.className = "button-secondary room-list-leave";
      leaveButton.textContent = "Leave";
      leaveButton.dataset.leaveCurrentRoom = "1";
      roomCard.appendChild(leaveButton);
    } else if (room.openSeat) {
      const joinButton = document.createElement("button");
      joinButton.type = "button";
      joinButton.className = "button-accent room-list-join";
      joinButton.textContent = "Join";
      joinButton.dataset.joinRoomId = room.roomId;
      roomCard.appendChild(joinButton);
    }

    elements.roomList.appendChild(roomCard);
  }

  if (elements.roomListEmpty) {
    const shouldShowEmpty = (
      !state.roomsLoading
      && !state.roomsError
      && rooms.length === 0
    );
    elements.roomListEmpty.hidden = !shouldShowEmpty;
  }
}

function buildSignalingSocketUrl(baseUrl, roomId, playerName = "", clientId = "") {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/ws/${encodeURIComponent(roomId)}`;
  const normalizedName = normalizePlayerName(playerName);
  const normalizedClientId = normalizeClientId(clientId);
  url.search = "";
  if (normalizedName) {
    url.searchParams.set("name", normalizedName);
  }
  if (normalizedClientId) {
    url.searchParams.set("client", normalizedClientId);
  }
  url.hash = "";
  return url.toString();
}

function normalizeRoomCode(rawValue) {
  const normalized = rawValue
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, "");
  if (normalized.length < 4) return "";
  return normalized.slice(0, 40);
}

function parseRoomInput(rawValue) {
  const value = rawValue.trim();
  if (!value) return null;

  const parseParams = (params) => {
    const room = params.get("room");
    if (!room) return null;
    const normalizedRoom = normalizeRoomCode(room);
    if (!normalizedRoom) {
      throw new Error("Room code is invalid.");
    }
    return normalizedRoom;
  };

  try {
    if (value.includes("://")) {
      const url = new URL(value);
      const fromParams = parseParams(url.searchParams);
      if (fromParams) return fromParams;
      const lastSegment = url.pathname.split("/").filter(Boolean).pop();
      const fromPath = normalizeRoomCode(lastSegment || "");
      if (fromPath) return fromPath;
    }
  } catch (error) {
    // Fall through to alternate parsing.
  }

  if (value.startsWith("?")) {
    const fromQuery = parseParams(new URLSearchParams(value.slice(1)));
    if (fromQuery) return fromQuery;
  }

  if (value.includes("room=") || value.includes("&")) {
    const fromPairs = parseParams(new URLSearchParams(value));
    if (fromPairs) return fromPairs;
  }

  const normalizedCode = normalizeRoomCode(value);
  if (normalizedCode) return normalizedCode;
  throw new Error("Room code is invalid.");
}

function generateRoomCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const createSegment = (length) => {
    if (window.crypto?.getRandomValues) {
      const bytes = new Uint8Array(length);
      window.crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
    }
    let fallback = "";
    for (let i = 0; i < length; i += 1) {
      fallback += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return fallback;
  };
  return `${createSegment(4)}-${createSegment(4)}`;
}

function buildRoomInviteUrl(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.delete("offer");
  url.searchParams.delete("answer");
  url.searchParams.set("room", roomId);
  url.searchParams.delete("signal");
  return url.toString();
}

function setRoomQueryParam(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.delete("offer");
  url.searchParams.delete("answer");
  if (roomId) {
    url.searchParams.set("room", roomId);
  } else {
    url.searchParams.delete("room");
  }
  url.searchParams.delete("signal");
  window.history.replaceState({}, "", url.toString());
}

function isSignalingOpen() {
  return Boolean(rtc.signalingSocket && rtc.signalingSocket.readyState === WebSocket.OPEN);
}

function isSignalingConnecting() {
  return Boolean(rtc.signalingSocket && rtc.signalingSocket.readyState === WebSocket.CONNECTING);
}

function canHostRenegotiate() {
  return state.gameMode === "p2p" && rtc.role === "host" && rtc.peerCount > 1;
}

function clearSignalingReconnectTimer() {
  if (!signalingReconnectTimer) return;
  clearTimeout(signalingReconnectTimer);
  signalingReconnectTimer = null;
}

function clearHostNegotiationRetryTimer() {
  if (!hostNegotiationRetryTimer) {
    rtc.queuedNegotiationIceRestart = false;
    rtc.queuedNegotiationReason = "";
    return;
  }
  clearTimeout(hostNegotiationRetryTimer);
  hostNegotiationRetryTimer = null;
  rtc.queuedNegotiationIceRestart = false;
  rtc.queuedNegotiationReason = "";
}

function clearHostDisconnectGraceTimer() {
  if (!hostDisconnectGraceTimer) return;
  clearTimeout(hostDisconnectGraceTimer);
  hostDisconnectGraceTimer = null;
}

function shouldAttemptSignalingReconnect() {
  return state.gameMode === "p2p" && Boolean(rtc.roomId) && !rtc.manualDisconnect;
}

function scheduleSignalingReconnect({ immediate = false } = {}) {
  if (!shouldAttemptSignalingReconnect()) return;
  if (isSignalingOpen() || isSignalingConnecting()) return;
  if (signalingReconnectTimer) return;
  const backoffStep = Math.max(0, rtc.signalingReconnectAttempts);
  const delayMs = immediate
    ? 0
    : Math.min(SIGNALING_RECONNECT_BASE_MS * (2 ** backoffStep), SIGNALING_RECONNECT_MAX_MS);
  signalingReconnectTimer = setTimeout(() => {
    signalingReconnectTimer = null;
    void reconnectSignalingSocket();
  }, delayMs);
}

async function reconnectSignalingSocket() {
  if (!shouldAttemptSignalingReconnect()) return;
  if (isSignalingOpen() || isSignalingConnecting()) return;
  try {
    const baseUrl = rtc.signalingBaseUrl || getSignalingBaseUrl();
    await openSignalingSocket(baseUrl, rtc.roomId, state.localPlayerName);
    rtc.signalingReconnectAttempts = 0;
    if (!rtc.connected) {
      updateNetworkStatus("Signaling restored. Reconnecting peer link...");
      render();
    }
    if (canHostRenegotiate() && !rtc.connected) {
      scheduleHostNegotiationRetry({
        delayMs: 250,
        reason: "Signaling reconnected.",
        iceRestart: true,
      });
    }
  } catch (error) {
    rtc.signalingReconnectAttempts += 1;
    if (!shouldAttemptSignalingReconnect()) return;
    state.message = "Signaling reconnect failed. Retrying...";
    updateNetworkStatus("Signaling reconnect failed. Retrying...");
    render();
    scheduleSignalingReconnect();
  }
}

function scheduleHostNegotiationRetry({
  delayMs = HOST_NEGOTIATION_RETRY_MS,
  reason = "",
  iceRestart = true,
} = {}) {
  if (!canHostRenegotiate()) return;
  if (iceRestart) {
    rtc.queuedNegotiationIceRestart = true;
  }
  if (reason) {
    rtc.queuedNegotiationReason = reason;
  }
  if (hostNegotiationRetryTimer) return;
  hostNegotiationRetryTimer = setTimeout(() => {
    hostNegotiationRetryTimer = null;
    if (!canHostRenegotiate() || rtc.connected) {
      rtc.queuedNegotiationIceRestart = false;
      rtc.queuedNegotiationReason = "";
      return;
    }
    const retryIceRestart = rtc.queuedNegotiationIceRestart;
    const retryReason = rtc.queuedNegotiationReason;
    rtc.queuedNegotiationIceRestart = false;
    rtc.queuedNegotiationReason = "";
    void startHostNegotiation({
      iceRestart: retryIceRestart,
      reason: retryReason,
    });
  }, Math.max(150, delayMs));
}

function scheduleHostDisconnectRecovery(reason = "") {
  if (!canHostRenegotiate()) return;
  if (hostDisconnectGraceTimer) return;
  hostDisconnectGraceTimer = setTimeout(() => {
    hostDisconnectGraceTimer = null;
    if (!canHostRenegotiate() || rtc.connected) return;
    void startHostNegotiation({
      iceRestart: true,
      reason: reason || "Peer disconnected.",
    });
    scheduleHostNegotiationRetry({
      delayMs: HOST_NEGOTIATION_RETRY_MS,
      reason: "Waiting for peer reconnection.",
      iceRestart: true,
    });
  }, HOST_DISCONNECT_GRACE_MS);
}

function closePeerTransport(keepRole = false) {
  clearHostDisconnectGraceTimer();
  clearHostNegotiationRetryTimer();
  rtc.negotiationInFlight = false;
  if (rtc.channel) {
    rtc.channel.onopen = null;
    rtc.channel.onclose = null;
    rtc.channel.onmessage = null;
    rtc.channel.onerror = null;
    if (rtc.channel.readyState !== "closed") {
      rtc.channel.close();
    }
  }
  if (rtc.pc) {
    rtc.pc.onconnectionstatechange = null;
    rtc.pc.oniceconnectionstatechange = null;
    rtc.pc.ondatachannel = null;
    rtc.pc.onicecandidate = null;
    rtc.pc.close();
  }
  rtc.pc = null;
  rtc.channel = null;
  rtc.connected = false;
  rtc.pendingRemoteCandidates = [];
  if (!keepRole) {
    rtc.role = null;
  }
}

function clearPeerSession() {
  clearSignalingReconnectTimer();
  clearHostDisconnectGraceTimer();
  clearHostNegotiationRetryTimer();
  const activeSocket = rtc.signalingSocket;
  rtc.signalingSocket = null;
  if (activeSocket) {
    activeSocket.onopen = null;
    activeSocket.onmessage = null;
    activeSocket.onerror = null;
    activeSocket.onclose = null;
    if (
      activeSocket.readyState === WebSocket.CONNECTING
      || activeSocket.readyState === WebSocket.OPEN
    ) {
      activeSocket.close();
    }
  }
  closePeerTransport();
  rtc.signalingBaseUrl = "";
  rtc.signalingReconnectAttempts = 0;
  rtc.roomId = "";
  rtc.peerCount = 0;
  rtc.generatedSignal = "";
  state.lastSyncedPayload = "";
  state.lastSyncedStateFingerprint = "";
  state.syncSeq = 0;
}

function openSignalingSocket(baseUrl, roomId, playerName = "") {
  rtc.signalingBaseUrl = baseUrl;
  const socketUrl = buildSignalingSocketUrl(
    baseUrl,
    roomId,
    playerName,
    ensureLocalClientId(),
  );
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    let settled = false;
    rtc.signalingSocket = socket;

    const fail = (message) => {
      if (settled) return;
      settled = true;
      if (rtc.signalingSocket === socket) {
        rtc.signalingSocket = null;
      }
      reject(new Error(message));
    };

    socket.onopen = () => {
      if (rtc.signalingSocket !== socket) return;
      clearSignalingReconnectTimer();
      rtc.signalingReconnectAttempts = 0;
      if (!settled) {
        settled = true;
        resolve();
      }
      updateNetworkStatus("Connected to signaling. Waiting for room assignment...");
      sendPlayerNameToSignaling();
      render();
    };

    socket.onerror = () => {
      fail("Could not connect to the signaling service.");
    };

    socket.onmessage = (event) => {
      void handleSignalingMessage(event.data);
    };

    socket.onclose = () => {
      if (rtc.signalingSocket !== socket) return;
      rtc.signalingSocket = null;
      if (!settled) {
        fail("Could not connect to the signaling service.");
        return;
      }
      if (shouldAttemptSignalingReconnect()) {
        if (rtc.connected) {
          state.message = "Signaling disconnected. Peer link still active.";
          updateNetworkStatus("Peer connected. Reconnecting signaling...");
        } else {
          state.message = "Signaling disconnected. Reconnecting...";
          updateNetworkStatus("Signaling disconnected. Reconnecting...");
          scheduleHostNegotiationRetry({
            delayMs: HOST_NEGOTIATION_RETRY_MS,
            reason: "Signaling dropped during negotiation.",
            iceRestart: true,
          });
        }
        scheduleSignalingReconnect();
      } else {
        rtc.connected = false;
        closePeerTransport(true);
        rtc.peerCount = 0;
        if (state.gameMode === "p2p") {
          state.message = "Disconnected from signaling.";
        }
        updateNetworkStatus();
      }
      void fetchAvailableRooms({ silent: true });
      render();
    };
  });
}

function sendSignalPayload(payload) {
  if (!isSignalingOpen()) {
    if (shouldAttemptSignalingReconnect()) {
      scheduleSignalingReconnect();
    }
    return false;
  }
  try {
    rtc.signalingSocket.send(JSON.stringify({ type: "signal", payload }));
    return true;
  } catch {
    if (shouldAttemptSignalingReconnect()) {
      scheduleSignalingReconnect();
    }
    return false;
  }
}

function sendRoomStateToSignaling(payload) {
  if (!isSignalingOpen()) {
    if (shouldAttemptSignalingReconnect()) {
      scheduleSignalingReconnect();
    }
    return false;
  }
  try {
    rtc.signalingSocket.send(JSON.stringify({
      type: "room-state",
      payload,
    }));
    return true;
  } catch {
    if (shouldAttemptSignalingReconnect()) {
      scheduleSignalingReconnect();
    }
    return false;
  }
}

function sendPlayerNameToSignaling({ name = state.localPlayerName, claim = false } = {}) {
  if (!isSignalingOpen()) {
    return false;
  }
  try {
    rtc.signalingSocket.send(JSON.stringify({
      type: "set-name",
      name: normalizePlayerName(name),
      claim: claim === true,
    }));
    return true;
  } catch {
    if (shouldAttemptSignalingReconnect()) {
      scheduleSignalingReconnect();
    }
    return false;
  }
}

function normalizeSyncSeq(rawValue) {
  if (Number.isInteger(rawValue) && rawValue >= 0) {
    return rawValue;
  }
  return null;
}

function buildSyncStateFingerprint(source) {
  const board = Array.isArray(source?.board) ? source.board : [];
  const dice = Array.isArray(source?.dice) ? source.dice : [];
  const diceOwners = Array.isArray(source?.diceOwners) ? source.diceOwners : [];
  const remainingDice = Array.isArray(source?.remainingDice) ? source.remainingDice : [];
  const bar = source?.bar && typeof source.bar === "object"
    ? source.bar
    : { player: 0, ai: 0 };
  const off = source?.off && typeof source.off === "object"
    ? source.off
    : { player: 0, ai: 0 };
  return JSON.stringify({
    board,
    bar: {
      player: Number(bar.player || 0),
      ai: Number(bar.ai || 0),
    },
    off: {
      player: Number(off.player || 0),
      ai: Number(off.ai || 0),
    },
    turn: source?.turn === "ai" ? "ai" : "player",
    dice,
    diceOwners,
    remainingDice,
    awaitingRoll: source?.awaitingRoll === true,
    openingRollPending: source?.openingRollPending === true,
    showNoMoveDice: source?.showNoMoveDice === true,
    gameOver: source?.gameOver === true,
    winnerSide: source?.winnerSide === "ai" ? "ai" : (source?.winnerSide === "player" ? "player" : ""),
    resignedBySide: source?.resignedBySide === "ai"
      ? "ai"
      : (source?.resignedBySide === "player" ? "player" : ""),
  });
}

function applyRemoteGameState(payload) {
  if (!payload) return;
  const incomingSyncSeq = normalizeSyncSeq(payload.syncSeq);
  if (incomingSyncSeq !== null && incomingSyncSeq < state.syncSeq) {
    return;
  }
  state.remoteSyncInProgress = true;
  try {
    state.board = [...payload.board];
    state.bar = { ...payload.bar };
    state.off = { ...payload.off };
    state.turn = payload.turn;
    state.dice = [...payload.dice];
    state.diceOwners = [...payload.diceOwners];
    state.remainingDice = [...payload.remainingDice];
    state.awaitingRoll = payload.awaitingRoll;
    state.openingRollPending = payload.openingRollPending === true;
    state.showNoMoveDice = payload.showNoMoveDice === true;
    state.gameOver = payload.gameOver === true;
    state.winnerSide = payload.winnerSide === "ai" || payload.winnerSide === "player"
      ? payload.winnerSide
      : "";
    state.resignedBySide = payload.resignedBySide === "ai" || payload.resignedBySide === "player"
      ? payload.resignedBySide
      : "";
    if (state.gameOver) {
      state.autoDiceEnabled = false;
      closeResignModal({ renderAfter: false });
    }
    const senderSide = payload.senderSide === "ai" ? "ai" : "player";
    const senderName = normalizePlayerName(payload.senderName || "");
    state.playerNames[senderSide] = senderName;
    if (state.gameOver && state.resignedBySide) {
      const resignedName = normalizePlayerName(state.playerNames[state.resignedBySide] || "");
      const resignedLabel = resignedName
        ? `Player (${resignedName})`
        : sideLabel(state.resignedBySide);
      state.message = state.resignedBySide === state.localSide
        ? `You resigned. ${capitalizeSide(otherSide(state.resignedBySide))} wins! Press New Game to play again.`
        : `${resignedLabel} resigned. ${capitalizeSide(otherSide(state.resignedBySide))} wins! Press New Game to play again.`;
    } else {
      state.message = payload.message || state.message;
    }
    state.selectedFrom = null;
    state.lastMoveSnapshot = null;
    state.aiMoveHighlights = { from: [], to: [] };
    if (incomingSyncSeq !== null) {
      state.syncSeq = Math.max(state.syncSeq, incomingSyncSeq);
    }
    state.lastSyncedStateFingerprint = buildSyncStateFingerprint(payload);
    state.lastSyncedPayload = "";
    render();
  } finally {
    state.remoteSyncInProgress = false;
  }
}

function buildSyncPayload() {
  return {
    board: [...state.board],
    bar: { ...state.bar },
    off: { ...state.off },
    turn: state.turn,
    dice: [...state.dice],
    diceOwners: [...state.diceOwners],
    remainingDice: [...state.remainingDice],
    awaitingRoll: state.awaitingRoll,
    openingRollPending: state.openingRollPending,
    showNoMoveDice: state.showNoMoveDice === true,
    gameOver: state.gameOver === true,
    winnerSide: state.winnerSide,
    resignedBySide: state.resignedBySide,
    syncSeq: state.syncSeq,
    senderSide: state.localSide,
    senderName: state.localPlayerName,
    message: state.message,
  };
}

function syncGameStateToPeer(force = false) {
  if (state.gameMode !== "p2p") return;
  if (state.remoteSyncInProgress) return;

  const payload = buildSyncPayload();
  const nextFingerprint = buildSyncStateFingerprint(payload);
  if (nextFingerprint !== state.lastSyncedStateFingerprint) {
    state.syncSeq += 1;
    state.lastSyncedStateFingerprint = nextFingerprint;
    payload.syncSeq = state.syncSeq;
  }
  const encoded = JSON.stringify(payload);
  if (!force && encoded === state.lastSyncedPayload) return;
  let sent = false;
  if (rtc.connected && rtc.channel && rtc.channel.readyState === "open") {
    rtc.channel.send(JSON.stringify({ type: "state-sync", payload }));
    sent = true;
  }
  if (sendRoomStateToSignaling(payload)) {
    sent = true;
  }
  if (sent) {
    state.lastSyncedPayload = encoded;
  }
}

function attachDataChannel(channel) {
  rtc.channel = channel;
  rtc.channel.onopen = () => {
    rtc.connected = true;
    clearHostDisconnectGraceTimer();
    if (hostNegotiationRetryTimer) {
      clearTimeout(hostNegotiationRetryTimer);
      hostNegotiationRetryTimer = null;
    }
    rtc.queuedNegotiationIceRestart = false;
    rtc.queuedNegotiationReason = "";
    state.message = "Peer connected.";
    updateNetworkStatus("Peer connected.");
    closeConnectionModal();
    render();
    syncGameStateToPeer(true);
  };
  rtc.channel.onclose = () => {
    rtc.connected = false;
    scheduleHostDisconnectRecovery("Data channel closed.");
    updateNetworkStatus("Peer disconnected.");
    render();
  };
  rtc.channel.onerror = () => {
    scheduleHostNegotiationRetry({
      delayMs: HOST_NEGOTIATION_RETRY_MS,
      reason: "Data channel error.",
      iceRestart: true,
    });
    updateNetworkStatus("Data channel error.");
    render();
  };
  rtc.channel.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "state-sync") {
        applyRemoteGameState(message.payload);
        return;
      }
      if (message.type === "resign") {
        handleRemoteResignNotice(message);
      }
    } catch (error) {
      state.message = "Received invalid peer message.";
      render();
    }
  };
}

function createPeerConnection(role) {
  rtc.role = role;
  if (rtc.pc) {
    return rtc.pc;
  }
  rtc.pc = new RTCPeerConnection(RTC_CONFIG);
  const handleRtcStateChange = () => {
    if (!rtc.pc) return;
    const connectionState = rtc.pc.connectionState;
    if (connectionState === "connected") {
      if (rtc.channel && rtc.channel.readyState === "open") {
        rtc.connected = true;
      }
      clearHostDisconnectGraceTimer();
      clearHostNegotiationRetryTimer();
    }
    if (connectionState === "disconnected") {
      rtc.connected = false;
      scheduleHostDisconnectRecovery("Peer connection disconnected.");
    }
    if (connectionState === "failed") {
      rtc.connected = false;
      scheduleHostNegotiationRetry({
        delayMs: 250,
        reason: "Peer connection failed.",
        iceRestart: true,
      });
    }
    if (connectionState === "closed") {
      rtc.connected = false;
      clearHostDisconnectGraceTimer();
    }
    updateNetworkStatus();
    render();
  };
  rtc.pc.onconnectionstatechange = () => {
    handleRtcStateChange();
  };
  rtc.pc.oniceconnectionstatechange = () => {
    if (!rtc.pc) return;
    const iceState = rtc.pc.iceConnectionState;
    if (iceState === "connected" || iceState === "completed") {
      clearHostDisconnectGraceTimer();
      clearHostNegotiationRetryTimer();
      if (rtc.channel && rtc.channel.readyState === "open") {
        rtc.connected = true;
      }
    }
    if (iceState === "disconnected") {
      rtc.connected = false;
      scheduleHostDisconnectRecovery("ICE disconnected.");
    }
    if (iceState === "failed") {
      rtc.connected = false;
      scheduleHostNegotiationRetry({
        delayMs: 250,
        reason: "ICE failed.",
        iceRestart: true,
      });
    }
    updateNetworkStatus();
    render();
  };
  rtc.pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    sendSignalPayload({ kind: "ice-candidate", candidate: event.candidate });
  };
  rtc.pc.ondatachannel = (event) => {
    attachDataChannel(event.channel);
  };
  return rtc.pc;
}

function ensureHostPeerConnection() {
  const pc = createPeerConnection("host");
  if (
    !rtc.channel
    || rtc.channel.readyState === "closed"
    || rtc.channel.readyState === "closing"
  ) {
    const dataChannel = pc.createDataChannel("bg-state");
    attachDataChannel(dataChannel);
  }
  return pc;
}

function ensureGuestPeerConnection() {
  return createPeerConnection("guest");
}

async function applyQueuedRemoteCandidates() {
  if (!rtc.pc || !rtc.pc.remoteDescription) return;
  while (rtc.pendingRemoteCandidates.length > 0) {
    const candidate = rtc.pendingRemoteCandidates.shift();
    try {
      await rtc.pc.addIceCandidate(candidate);
    } catch (error) {
      // Ignore malformed/stale candidates and keep the session running.
    }
  }
}

async function startHostNegotiation({ iceRestart = false, reason = "" } = {}) {
  if (!canHostRenegotiate()) return false;
  if (!isSignalingOpen()) {
    scheduleSignalingReconnect();
    scheduleHostNegotiationRetry({
      delayMs: HOST_NEGOTIATION_RETRY_MS,
      reason: reason || "Waiting for signaling connection.",
      iceRestart: true,
    });
    return false;
  }
  if (rtc.negotiationInFlight) {
    if (iceRestart) {
      rtc.queuedNegotiationIceRestart = true;
    }
    if (reason) {
      rtc.queuedNegotiationReason = reason;
    }
    return false;
  }
  const pc = ensureHostPeerConnection();
  if (pc.signalingState !== "stable") {
    scheduleHostNegotiationRetry({
      delayMs: HOST_NEGOTIATION_RETRY_MS,
      reason: reason || "Waiting for stable signaling state.",
      iceRestart: true,
    });
    return false;
  }
  rtc.negotiationInFlight = true;
  try {
    const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await pc.setLocalDescription(offer);
    if (!sendSignalPayload({ kind: "offer", description: pc.localDescription })) {
      scheduleSignalingReconnect({ immediate: true });
      scheduleHostNegotiationRetry({
        delayMs: HOST_NEGOTIATION_RETRY_MS,
        reason: reason || "Signaling unavailable during offer send.",
        iceRestart: true,
      });
      return false;
    }
    if (hostNegotiationRetryTimer) {
      clearTimeout(hostNegotiationRetryTimer);
      hostNegotiationRetryTimer = null;
    }
    state.message = iceRestart
      ? `Reconnecting peer link with ${sideLabel("ai")}...`
      : `Offer sent to ${sideLabel("ai")}. Waiting for answer...`;
    updateNetworkStatus();
    render();
    return true;
  } catch (error) {
    scheduleHostNegotiationRetry({
      delayMs: HOST_NEGOTIATION_RETRY_MS,
      reason: `Negotiation failed: ${error?.message || "unknown error"}.`,
      iceRestart: true,
    });
    updateNetworkStatus("WebRTC negotiation failed. Retrying...");
    render();
    return false;
  } finally {
    rtc.negotiationInFlight = false;
    if (rtc.queuedNegotiationIceRestart || rtc.queuedNegotiationReason) {
      const queuedReason = rtc.queuedNegotiationReason;
      const queuedIceRestart = rtc.queuedNegotiationIceRestart;
      rtc.queuedNegotiationReason = "";
      rtc.queuedNegotiationIceRestart = false;
      scheduleHostNegotiationRetry({
        delayMs: 250,
        reason: queuedReason,
        iceRestart: queuedIceRestart,
      });
    }
  }
}

async function handleOfferSignal(description) {
  if (rtc.role !== "guest") return;
  if (rtc.pc) {
    closePeerTransport(true);
  }
  const pc = ensureGuestPeerConnection();
  await pc.setRemoteDescription(description);
  await applyQueuedRemoteCandidates();
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  if (!sendSignalPayload({ kind: "answer", description: pc.localDescription })) {
    throw new Error("Could not send answer: signaling channel is closed.");
  }
  state.message = `Answer sent. Connecting to ${sideLabel("player")}...`;
  updateNetworkStatus("Answer sent. Connecting...");
  render();
}

async function handleAnswerSignal(description) {
  if (rtc.role !== "host" || !rtc.pc) return;
  await rtc.pc.setRemoteDescription(description);
  await applyQueuedRemoteCandidates();
  state.message = "Answer received. Finalizing peer connection...";
  if (!rtc.connected) {
    scheduleHostNegotiationRetry({
      delayMs: HOST_NEGOTIATION_RETRY_MS,
      reason: "Awaiting final WebRTC connection.",
      iceRestart: true,
    });
  }
  updateNetworkStatus();
  render();
}

async function handleIceCandidateSignal(candidate) {
  if (!candidate) return;
  if (!rtc.pc || !rtc.pc.remoteDescription) {
    rtc.pendingRemoteCandidates.push(candidate);
    return;
  }
  try {
    await rtc.pc.addIceCandidate(candidate);
  } catch (error) {
    // Ignore stale candidates after renegotiation/reconnect.
  }
}

async function handleIncomingSignal(payload) {
  if (!payload || typeof payload.kind !== "string") return;
  try {
    if (payload.kind === "offer") {
      await handleOfferSignal(payload.description);
      return;
    }
    if (payload.kind === "answer") {
      await handleAnswerSignal(payload.description);
      return;
    }
    if (payload.kind === "ice-candidate") {
      await handleIceCandidateSignal(payload.candidate);
      return;
    }
    if (payload.kind === "resign") {
      handleRemoteResignNotice(payload);
    }
  } catch (error) {
    state.message = `Signal handling failed: ${error?.message || "unexpected error"}.`;
    scheduleHostNegotiationRetry({
      delayMs: HOST_NEGOTIATION_RETRY_MS,
      reason: "Recovering from signaling error.",
      iceRestart: true,
    });
    updateNetworkStatus();
    render();
  }
}

async function handleSignalingMessage(rawData) {
  let message;
  try {
    message = JSON.parse(rawData);
  } catch (error) {
    state.message = "Received invalid signaling message.";
    render();
    return;
  }

  if (message.type === "joined") {
    const previousRoomId = rtc.roomId;
    const previousRole = rtc.role;
    const joinedRoomId = normalizeRoomCode(message.roomId || rtc.roomId) || rtc.roomId;
    const joinedRole = message.role === "host" ? "host" : "guest";
    const isSignalingRejoin = Boolean(
      previousRoomId
      && previousRole
      && previousRoomId === joinedRoomId
      && previousRole === joinedRole,
    );
    rtc.roomId = joinedRoomId;
    rtc.peerCount = Number.isInteger(message.peerCount) ? message.peerCount : rtc.peerCount;
    rtc.signalingReconnectAttempts = 0;
    clearSignalingReconnectTimer();
    rtc.role = joinedRole;
    state.localSide = rtc.role === "host" ? "player" : "ai";
    applyRoomRoster(message.players);
    if (message.roomState && typeof message.roomState === "object") {
      const roomStateHasSyncSeq = normalizeSyncSeq(message.roomState.syncSeq) !== null;
      if (!isSignalingRejoin || roomStateHasSyncSeq) {
        applyRemoteGameState(message.roomState);
      }
    }
    if (rtc.role === "host") {
      ensureHostPeerConnection();
      state.message = `Room ${rtc.roomId} created. Waiting for ${sideLabel("ai")}.`;
      if (rtc.peerCount > 1) {
        await startHostNegotiation({
          reason: "Peer already present in room.",
          iceRestart: false,
        });
      }
    } else {
      ensureGuestPeerConnection();
      state.message = `Joined room ${rtc.roomId} as ${sideLabel("ai")}. Waiting for ${sideLabel("player")}...`;
    }
    syncGameStateToPeer(true);
    updateNetworkStatus();
    void fetchAvailableRooms({ silent: true });
    render();
    return;
  }

  if (message.type === "peer-joined") {
    rtc.peerCount = Number.isInteger(message.peerCount)
      ? message.peerCount
      : Math.max(rtc.peerCount + 1, 2);
    if (rtc.role === "host") {
      state.message = `${sideLabel("ai")} joined. Starting connection...`;
      updateNetworkStatus();
      render();
      await startHostNegotiation({
        reason: "Peer joined room.",
        iceRestart: false,
      });
    } else {
      updateNetworkStatus();
      render();
    }
    applyRoomRoster(message.players);
    void fetchAvailableRooms({ silent: true });
    render();
    return;
  }

  if (message.type === "peer-left") {
    rtc.peerCount = Number.isInteger(message.peerCount)
      ? message.peerCount
      : Math.max(1, rtc.peerCount - 1);
    rtc.connected = false;
    closePeerTransport(true);
    if (rtc.role === "host") {
      ensureHostPeerConnection();
    }
    applyRoomRoster(message.players);
    state.message = "Peer left the room.";
    updateNetworkStatus();
    void fetchAvailableRooms({ silent: true });
    render();
    return;
  }

  if (message.type === "peer-name") {
    const remoteSide = message.role === "guest" ? "ai" : "player";
    state.playerNames[remoteSide] = normalizePlayerName(message.name || "");
    state.playerNames[state.localSide] = state.localPlayerName;
    void fetchAvailableRooms({ silent: true });
    render();
    return;
  }

  if (message.type === "name-updated") {
    const confirmedName = normalizePlayerName(message.name || state.localPlayerName);
    state.localPlayerName = confirmedName;
    state.playerNames[state.localSide] = confirmedName;
    saveProfileToStorage();
    clearNameClaimCandidate();
    if (message.claimed) {
      setNameStatus(`You claimed "${confirmedName}".`);
      state.message = `You claimed the name ${confirmedName}.`;
    } else {
      setNameStatus("");
    }
    void fetchAvailableRooms({ silent: true });
    render();
    return;
  }

  if (message.type === "name-conflict") {
    const requestedName = normalizePlayerName(
      message.requestedName || elements.playerNameInput?.value || "",
    );
    if (requestedName) {
      state.nameClaimCandidate = requestedName;
      if (elements.playerNameInput) {
        elements.playerNameInput.value = requestedName;
      }
      setNameStatus("Name is already taken. Click Claim My Name to take it over.", { isError: true });
      state.message = `Name "${requestedName}" is already taken. Click Claim My Name to take it over.`;
    } else {
      setNameStatus("Name is already taken. Choose another name.", { isError: true });
      state.message = "Name is already taken. Choose another name.";
    }
    render();
    return;
  }

  if (message.type === "signal") {
    await handleIncomingSignal(message.payload);
    return;
  }

  if (message.type === "error") {
    state.message = message.message || "Signaling error.";
    render();
  }
}

async function connectToRoom(roomValue) {
  const roomId = parseRoomInput(roomValue);
  if (!roomId) {
    throw new Error("Room id is invalid.");
  }

  const signalingBaseUrl = getSignalingBaseUrl();
  if (state.localPlayerName) {
    const reservation = await reservePlayerName(state.localPlayerName, { claim: false });
    if (!reservation.ok) {
      const conflictingName = normalizePlayerName(reservation.name || state.localPlayerName);
      state.nameClaimCandidate = conflictingName;
      if (elements.playerNameInput) {
        elements.playerNameInput.value = conflictingName;
      }
      setNameStatus("Name is already taken. Click Claim My Name to take it over.", { isError: true });
      throw new Error(`Name "${conflictingName}" is already taken. Use Claim My Name first.`);
    }
  }

  clearPeerSession();
  rtc.autoRejoinBlockedRoomId = "";
  rtc.autoRejoinBlockedUpdatedAt = 0;
  rtc.manualDisconnect = false;
  rtc.signalingReconnectAttempts = 0;
  rtc.signalingBaseUrl = signalingBaseUrl;
  state.gameMode = "p2p";
  state.playerNames[state.localSide] = state.localPlayerName;
  rtc.roomId = roomId;
  rtc.generatedSignal = buildRoomInviteUrl(roomId);
  setRoomQueryParam(roomId);

  state.message = `Connecting to room ${roomId}...`;
  updateNetworkStatus("Connecting to signaling...");
  render();

  try {
    await openSignalingSocket(signalingBaseUrl, roomId, state.localPlayerName);
    void fetchAvailableRooms({ silent: true });
  } catch (error) {
    clearPeerSession();
    state.gameMode = "ai";
    state.localSide = "player";
    state.playerNames.player = state.localPlayerName;
    setRoomQueryParam("");
    throw error;
  }
}

async function createRoomAndConnect() {
  const roomId = generateRoomCode();
  await connectToRoom(roomId);
}

function disconnectPeerSession() {
  const previousRoomId = rtc.roomId;
  rtc.manualDisconnect = true;
  clearPeerSession();
  rtc.roomId = "";
  state.gameMode = "ai";
  state.localSide = "player";
  state.showNoMoveDice = false;
  state.playerNames.player = state.localPlayerName;
  state.message = "Left room. Back to vs computer.";
  setRoomQueryParam("");
  closeConnectionModal({ renderAfter: false });
  closeResignModal({ renderAfter: false });
  updateNetworkStatus("Disconnected.");
  if (previousRoomId) {
    void fetchAvailableRooms({ silent: true });
  }
  render();
}

async function handleJoinRoom(roomId) {
  try {
    await connectToRoom(roomId);
  } catch (error) {
    state.message = error.message || "Failed to join room.";
    render();
  }
}

async function prefillSignalFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const room = normalizeRoomCode(params.get("room") || "");
  if (!room) {
    void fetchAvailableRooms({ silent: true });
    return;
  }

  state.gameMode = "p2p";
  state.message = `Room ${room} detected. Connecting...`;
  render();
  try {
    await connectToRoom(room);
  } catch (error) {
    state.message = error.message || "Failed to connect to room.";
    render();
  }
}

function handleKeyboardShortcut(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (state.resignModalOpen) {
    if (key === "escape") {
      event.preventDefault();
      closeResignModal();
    }
    return;
  }
  if (state.networkModalOpen) {
    if (key === "escape") {
      event.preventDefault();
      closeConnectionModal();
    }
    return;
  }
  const target = event.target;
  const isEditable =
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT");
  if (isEditable) return;
  if (key === "enter") {
    if (canLocalRoll()) {
      event.preventDefault();
      rollForTurn();
    }
    return;
  }
  if (key === "r") {
    if (canLocalRoll()) {
      event.preventDefault();
      rollForTurn();
    }
    return;
  }
  if (key === "n") {
    event.preventDefault();
    handlePrimaryGameAction();
    return;
  }
  if (key === "e") {
    event.preventDefault();
    state.message = "Turn ended.";
    endTurn();
    return;
  }
  if (key === "u") {
    event.preventDefault();
    if (!elements.undoMove.disabled) {
      restoreSnapshot(state.lastMoveSnapshot);
      state.message = "All moves for this dice roll were undone.";
      render();
      syncGameStateToPeer();
    }
    return;
  }
  if (key === "b") {
    event.preventDefault();
    handleBearOff();
    return;
  }
}

function setupListeners() {
  elements.roomAction?.addEventListener("click", () => {
    openConnectionModal();
  });
  elements.autoDiceToggle?.addEventListener("click", () => {
    if (state.gameMode !== "p2p") return;
    state.autoDiceEnabled = !state.autoDiceEnabled;
    state.message = state.autoDiceEnabled
      ? "Auto dice enabled for your turns."
      : "Auto dice disabled. Roll manually.";
    render();
  });
  elements.updatePlayerName?.addEventListener("click", () => {
    void submitPlayerNameUpdate({ claim: false, announce: true });
  });
  elements.claimPlayerName?.addEventListener("click", () => {
    void submitPlayerNameUpdate({ claim: true, announce: true });
  });
  elements.playerNameInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitPlayerNameUpdate({ claim: false, announce: true });
    }
  });
  elements.playerNameInput?.addEventListener("input", () => {
    if (!elements.updatePlayerName || !elements.playerNameInput) return;
    const pendingName = normalizePlayerName(elements.playerNameInput?.value || "");
    if (
      state.nameClaimCandidate
      && state.nameClaimCandidate.toLowerCase() !== pendingName.toLowerCase()
    ) {
      clearNameClaimCandidate();
      setNameStatus("");
    }
    elements.updatePlayerName.disabled =
      state.nameUpdatePending || pendingName === state.localPlayerName;
    if (elements.claimPlayerName) {
      elements.claimPlayerName.hidden = !state.nameClaimCandidate
        || state.nameClaimCandidate.toLowerCase() !== pendingName.toLowerCase();
      elements.claimPlayerName.disabled = state.nameUpdatePending || elements.claimPlayerName.hidden;
    }
    render();
  });
  elements.roomModalClose?.addEventListener("click", () => {
    closeConnectionModal();
  });
  elements.roomModal?.addEventListener("click", (event) => {
    if (event.target === elements.roomModal) {
      closeConnectionModal();
    }
  });
  elements.resignModalClose?.addEventListener("click", () => {
    closeResignModal();
  });
  elements.resignCancel?.addEventListener("click", () => {
    closeResignModal();
  });
  elements.resignConfirm?.addEventListener("click", () => {
    confirmResign();
  });
  elements.resignModal?.addEventListener("click", (event) => {
    if (event.target === elements.resignModal) {
      closeResignModal();
    }
  });

  elements.board.addEventListener("click", handleBoardClick);
  elements.dice.addEventListener("click", () => {
    if (!canLocalRoll()) return;
    rollForTurn();
  });
  elements.dice.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (!canLocalRoll()) return;
    event.preventDefault();
    rollForTurn();
  });
  elements.newGame.addEventListener("click", () => {
    handlePrimaryGameAction();
  });
  elements.bearOff.addEventListener("click", handleBearOff);
  elements.endTurn.addEventListener("click", () => {
    state.message = "Turn ended.";
    endTurn();
  });
  elements.undoMove.addEventListener("click", () => {
    if (!state.lastMoveSnapshot || !isLocalTurn()) return;
    restoreSnapshot(state.lastMoveSnapshot);
    state.message = "All moves for this dice roll were undone.";
    render();
    syncGameStateToPeer();
  });
  elements.createRoom?.addEventListener("click", async () => {
    if (state.gameMode === "p2p" && rtc.roomId) {
      state.message = "Leave your current room before creating a new one.";
      render();
      return;
    }
    try {
      await createRoomAndConnect();
      void fetchAvailableRooms({ silent: true });
    } catch (error) {
      state.message = error.message || "Failed to create room.";
      render();
    }
  });
  elements.refreshRooms?.addEventListener("click", () => {
    void fetchAvailableRooms();
  });
  elements.roomList?.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const leaveButton = event.target.closest("button[data-leave-current-room]");
    if (leaveButton instanceof HTMLButtonElement) {
      disconnectPeerSession();
      return;
    }
    const joinButton = event.target.closest("button[data-join-room-id]");
    if (!(joinButton instanceof HTMLButtonElement)) return;
    const roomId = joinButton.dataset.joinRoomId || "";
    if (!roomId) return;
    void handleJoinRoom(roomId);
  });
  window.addEventListener("resize", () => {
    updateCheckerSize();
    maybeScheduleAutoDiceRoll();
  });
  document.addEventListener("keydown", handleKeyboardShortcut);
}

loadProfileFromStorage();
setupListeners();
initBoard();
void prefillSignalFromQuery();
render();
