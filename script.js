const POINTS = 24;
const TOTAL_CHECKERS = 15;
const STORAGE_KEY = "bg-save";
const AI_MOVE_TOTAL_MS = 3000;
const AI_MOVE_MIN_STEP_MS = 450;
const COMMIT_VERSION = "V2026-02-08-5";
const SIGNALING_BASE_URL = "https://bg-rendezvous.hilbert.workers.dev";
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
  networkModalOpen: false,
  remoteSyncInProgress: false,
  lastSyncedPayload: "",
};

const rtc = {
  pc: null,
  channel: null,
  role: null,
  connected: false,
  signalingSocket: null,
  roomId: "",
  peerCount: 0,
  pendingRemoteCandidates: [],
  generatedSignal: "",
};

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
  save: document.getElementById("save"),
  load: document.getElementById("load"),
  roomAction: document.getElementById("room-action"),
  networkStatus: document.getElementById("network-status"),
  copyInvite: document.getElementById("copy-invite"),
  joinLink: document.getElementById("join-link"),
  signalInput: document.getElementById("signal-input"),
  signalOutput: document.getElementById("signal-output"),
  roomModal: document.getElementById("room-modal"),
  roomModalClose: document.getElementById("room-modal-close"),
  commitVersion: document.getElementById("commit-version"),
};

function otherSide(side) {
  return side === "player" ? "ai" : "player";
}

function sideLabel(side) {
  if (state.gameMode === "p2p") {
    return side === "player" ? "Player (Host)" : "Player (Guest)";
  }
  return side === "player" ? "Player" : "Computer";
}

function sideBarLabel(side) {
  if (state.gameMode === "p2p") {
    return side === "player" ? "PLAYER (HOST) BAR" : "PLAYER (GUEST) BAR";
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
  if (!state.awaitingRoll) return false;
  if (state.openingRollPending) return state.localSide === "player";
  return isLocalTurn();
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
  state.message = "Opening roll: click the dice to decide who starts.";
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
  if (state.openingRollPending) {
    handleOpeningRoll();
    return;
  }

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
    state.dice = [];
    state.diceOwners = [];
    state.remainingDice = [];
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
  state.awaitingRoll = false;
  const playerDie = rollDie();
  const aiDie = rollDie();
  state.dice = [playerDie, aiDie];
  state.diceOwners = ["player", "ai"];

  if (playerDie === aiDie) {
    state.remainingDice = [];
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
    state.dice = [];
    state.diceOwners = [];
    state.remainingDice = [];
    state.lastMoveSnapshot = null;
    state.turn = otherSide(winner);
    render();
    syncGameStateToPeer();
    setTimeout(rollForTurn, 500);
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
    state.message = "Play vs human selected. Create or join a room.";
  }
  if (elements.signalInput && !elements.signalInput.value.trim()) {
    elements.signalInput.focus();
  }
  render();
}

function closeConnectionModal({ renderAfter = true } = {}) {
  if (!elements.roomModal) return;
  state.networkModalOpen = false;
  elements.roomModal.hidden = true;
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

function render() {
  updateSelectionHints();
  elements.topRow.innerHTML = "";
  elements.bottomRow.innerHTML = "";

  const topPoints = buildPointOrder("top");
  const bottomPoints = buildPointOrder("bottom");

  renderRow(elements.topRow, topPoints, "top");
  renderRow(elements.bottomRow, bottomPoints, "bottom");

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
  elements.undoMove.disabled =
    !isLocalTurn() || state.awaitingRoll || !state.lastMoveSnapshot;
  elements.endTurn.disabled = !isLocalTurn() || state.awaitingRoll;
  elements.bearOff.disabled =
    !isLocalTurn() || state.awaitingRoll || !state.canBearOffSelection;
  if (elements.roomAction) {
    const inRoom = state.gameMode === "p2p";
    elements.roomAction.textContent = inRoom ? "LEAVE room" : "Play vs human";
    elements.roomAction.classList.toggle("leave", inRoom);
    elements.roomAction.setAttribute("aria-expanded", state.networkModalOpen ? "true" : "false");
  }
  if (elements.roomModal) {
    elements.roomModal.hidden = !state.networkModalOpen;
  }
  updateNetworkStatus();

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
  if (canLocalRoll()) {
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
  if (!isLocalTurn()) return;
  if (state.awaitingRoll) {
    state.message = "Roll the dice before ending your turn.";
    render();
    return;
  }
  if (hasAnyLegalMoves(state, "player", state.remainingDice)) {
    state.message = "You must play all usable dice before ending your turn.";
    render();
    return;
  }
  state.selectedFrom = null;
  state.lastMoveSnapshot = null;
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
    state.message = `${capitalizeSide(player)} wins! Start a new game to play again.`;
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
  state.turn = "player";
  state.openingRollPending = false;
  state.selectedFrom = null;
  state.dice = [];
  state.remainingDice = [];
  state.diceOwners = [];
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
  state.selectedFrom = null;
  state.message = "Loaded saved game.";
  state.lastMoveSnapshot = null;
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
    elements.networkStatus.textContent = `${roomPrefix}Connected. You are ${sideLabel(state.localSide)}.`;
    return;
  }
  if (rtc.signalingSocket && rtc.signalingSocket.readyState === WebSocket.OPEN) {
    if (!rtc.role) {
      elements.networkStatus.textContent = `${roomPrefix}Connected to signaling. Waiting for role assignment...`;
      return;
    }
    if (rtc.role === "host") {
      elements.networkStatus.textContent = rtc.peerCount > 1
        ? `${roomPrefix}Player (Guest) joined. Negotiating WebRTC...`
        : `${roomPrefix}You are Player (Host). Waiting for Player (Guest).`;
      return;
    }
    elements.networkStatus.textContent = `${roomPrefix}You are Player (Guest). Waiting for Player (Host) offer...`;
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

function buildSignalingSocketUrl(baseUrl, roomId) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/ws/${encodeURIComponent(roomId)}`;
  url.search = "";
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
  throw new Error("Paste a room code or invite link with ?room=...");
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

function closePeerTransport(keepRole = false) {
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
  rtc.roomId = "";
  rtc.peerCount = 0;
  rtc.generatedSignal = "";
}

function openSignalingSocket(baseUrl, roomId) {
  const socketUrl = buildSignalingSocketUrl(baseUrl, roomId);
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
      if (!settled) {
        settled = true;
        resolve();
      }
      updateNetworkStatus("Connected to signaling. Waiting for room assignment...");
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
      rtc.connected = false;
      closePeerTransport(true);
      rtc.peerCount = 0;
      if (state.gameMode === "p2p") {
        state.message = "Disconnected from signaling.";
      }
      updateNetworkStatus();
      render();
    };
  });
}

function sendSignalPayload(payload) {
  if (!rtc.signalingSocket || rtc.signalingSocket.readyState !== WebSocket.OPEN) {
    return false;
  }
  rtc.signalingSocket.send(JSON.stringify({ type: "signal", payload }));
  return true;
}

function applyRemoteGameState(payload) {
  if (!payload) return;
  state.remoteSyncInProgress = true;
  state.board = [...payload.board];
  state.bar = { ...payload.bar };
  state.off = { ...payload.off };
  state.turn = payload.turn;
  state.dice = [...payload.dice];
  state.diceOwners = [...payload.diceOwners];
  state.remainingDice = [...payload.remainingDice];
  state.awaitingRoll = payload.awaitingRoll;
  state.openingRollPending = payload.openingRollPending === true;
  state.message = payload.message || state.message;
  state.selectedFrom = null;
  state.lastMoveSnapshot = null;
  state.aiMoveHighlights = { from: [], to: [] };
  state.lastSyncedPayload = JSON.stringify(payload);
  render();
  state.remoteSyncInProgress = false;
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
    message: state.message,
  };
}

function syncGameStateToPeer(force = false) {
  if (state.gameMode !== "p2p") return;
  if (state.remoteSyncInProgress) return;
  if (!rtc.connected || !rtc.channel || rtc.channel.readyState !== "open") return;

  const payload = buildSyncPayload();
  const encoded = JSON.stringify(payload);
  if (!force && encoded === state.lastSyncedPayload) return;
  state.lastSyncedPayload = encoded;
  rtc.channel.send(JSON.stringify({ type: "state-sync", payload }));
}

function attachDataChannel(channel) {
  rtc.channel = channel;
  rtc.channel.onopen = () => {
    rtc.connected = true;
    state.message = "Peer connected.";
    updateNetworkStatus("Peer connected.");
    closeConnectionModal();
    render();
    if (rtc.role === "host") {
      syncGameStateToPeer(true);
    }
  };
  rtc.channel.onclose = () => {
    rtc.connected = false;
    updateNetworkStatus("Peer disconnected.");
    render();
  };
  rtc.channel.onerror = () => {
    updateNetworkStatus("Data channel error.");
    render();
  };
  rtc.channel.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "state-sync") {
        applyRemoteGameState(message.payload);
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
  rtc.pc.onconnectionstatechange = () => {
    if (!rtc.pc) return;
    if (rtc.pc.connectionState === "connected") {
      rtc.connected = true;
    }
    if (
      rtc.pc.connectionState === "failed"
      || rtc.pc.connectionState === "closed"
      || rtc.pc.connectionState === "disconnected"
    ) {
      rtc.connected = false;
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
  if (!rtc.channel || rtc.channel.readyState === "closed") {
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

async function startHostNegotiation() {
  if (rtc.role !== "host") return;
  if (rtc.peerCount < 2) return;
  const pc = ensureHostPeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  if (!sendSignalPayload({ kind: "offer", description: pc.localDescription })) {
    throw new Error("Signaling channel is not open.");
  }
  state.message = "Offer sent to Player (Guest). Waiting for answer...";
  updateNetworkStatus();
  render();
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
  state.message = "Answer sent. Connecting to Player (Host)...";
  updateNetworkStatus("Answer sent. Connecting...");
  render();
}

async function handleAnswerSignal(description) {
  if (rtc.role !== "host" || !rtc.pc) return;
  await rtc.pc.setRemoteDescription(description);
  await applyQueuedRemoteCandidates();
  state.message = "Answer received. Finalizing peer connection...";
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
    rtc.roomId = normalizeRoomCode(message.roomId || rtc.roomId) || rtc.roomId;
    rtc.peerCount = Number.isInteger(message.peerCount) ? message.peerCount : rtc.peerCount;
    rtc.role = message.role === "host" ? "host" : "guest";
    state.localSide = rtc.role === "host" ? "player" : "ai";
    if (rtc.role === "host") {
      ensureHostPeerConnection();
      state.message = `Room ${rtc.roomId} ready. Share the room link with Player (Guest).`;
      if (rtc.peerCount > 1) {
        await startHostNegotiation();
      }
    } else {
      ensureGuestPeerConnection();
      state.message = `Joined room ${rtc.roomId} as Player (Guest). Waiting for Player (Host)...`;
    }
    updateNetworkStatus();
    render();
    return;
  }

  if (message.type === "peer-joined") {
    rtc.peerCount = Number.isInteger(message.peerCount)
      ? message.peerCount
      : Math.max(rtc.peerCount + 1, 2);
    if (rtc.role === "host") {
      state.message = "Player (Guest) joined. Starting connection...";
      updateNetworkStatus();
      render();
      await startHostNegotiation();
    } else {
      updateNetworkStatus();
      render();
    }
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
    state.message = "Peer left the room.";
    updateNetworkStatus();
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
    throw new Error("Paste a room code or invite link first.");
  }

  const signalingBaseUrl = getSignalingBaseUrl();

  clearPeerSession();
  state.gameMode = "p2p";
  rtc.roomId = roomId;
  rtc.generatedSignal = buildRoomInviteUrl(roomId);
  if (elements.signalInput) {
    elements.signalInput.value = roomId;
  }
  if (elements.signalOutput) {
    elements.signalOutput.value = rtc.generatedSignal;
  }
  setRoomQueryParam(roomId);

  state.message = `Connecting to room ${roomId}...`;
  updateNetworkStatus("Connecting to signaling...");
  render();

  try {
    await openSignalingSocket(signalingBaseUrl, roomId);
  } catch (error) {
    clearPeerSession();
    state.gameMode = "ai";
    state.localSide = "player";
    setRoomQueryParam("");
    throw error;
  }
}

async function createRoomAndConnect() {
  const roomId = generateRoomCode();
  await connectToRoom(roomId);
}

function disconnectPeerSession() {
  clearPeerSession();
  rtc.roomId = "";
  state.gameMode = "ai";
  state.localSide = "player";
  state.message = "Left room. Back to vs computer.";
  setRoomQueryParam("");
  if (elements.signalOutput) {
    elements.signalOutput.value = "";
  }
  closeConnectionModal({ renderAfter: false });
  updateNetworkStatus("Disconnected.");
  render();
}

async function copySignalOutput(successMessage) {
  const code = elements.signalOutput?.value.trim() || "";
  if (!code) {
    state.message = "No link to copy yet.";
    render();
    return false;
  }
  try {
    await writeClipboardText(code);
    state.message = successMessage || "Link copied.";
  } catch (error) {
    state.message = "Clipboard copy failed. Copy manually.";
  }
  render();
  return true;
}

async function writeClipboardText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const fallback = document.createElement("textarea");
  fallback.value = value;
  fallback.setAttribute("readonly", "");
  fallback.style.position = "fixed";
  fallback.style.opacity = "0";
  fallback.style.pointerEvents = "none";
  document.body.appendChild(fallback);
  fallback.focus();
  fallback.select();
  const didCopy = document.execCommand("copy");
  document.body.removeChild(fallback);
  if (!didCopy) {
    throw new Error("Clipboard copy is unavailable.");
  }
}

async function readClipboardText() {
  if (!navigator.clipboard?.readText) {
    throw new Error("Clipboard paste is unavailable in this browser.");
  }
  return navigator.clipboard.readText();
}

async function pasteSignalInputFromClipboard() {
  if (!elements.signalInput) return false;
  const text = (await readClipboardText()).trim();
  if (!text) {
    throw new Error("Clipboard is empty.");
  }
  elements.signalInput.value = text;
  return true;
}

async function handleJoinLink() {
  try {
    if (!(elements.signalInput?.value.trim() || "")) {
      try {
        await pasteSignalInputFromClipboard();
      } catch (error) {
        // Ignore clipboard read failures and keep manual input flow.
      }
    }
    const inputValue = elements.signalInput?.value || "";
    const roomId = parseRoomInput(inputValue);
    if (!roomId) {
      state.message = "Paste a room code or invite link first.";
      render();
      return;
    }
    await connectToRoom(roomId);
  } catch (error) {
    state.message = error.message || "Failed to join room.";
    render();
  }
}

async function prefillSignalFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const room = normalizeRoomCode(params.get("room") || "");
  if (!room) return;

  state.gameMode = "p2p";
  if (elements.signalInput) {
    elements.signalInput.value = room;
  }
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
    if (state.gameMode === "p2p" && state.localSide !== "player") {
      state.message = "Only host can start a new network game.";
      render();
      return;
    }
    initBoard();
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
  if (key === "s") {
    event.preventDefault();
    saveStateToStorage();
    state.message = "Game saved.";
    render();
    return;
  }
  if (key === "l") {
    event.preventDefault();
    loadStateFromStorage();
  }
}

function setupListeners() {
  elements.roomAction?.addEventListener("click", () => {
    if (state.gameMode === "p2p") {
      disconnectPeerSession();
      return;
    }
    openConnectionModal();
  });
  elements.roomModalClose?.addEventListener("click", () => {
    closeConnectionModal();
  });
  elements.roomModal?.addEventListener("click", (event) => {
    if (event.target === elements.roomModal) {
      closeConnectionModal();
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
    if (state.gameMode === "p2p" && state.localSide !== "player") {
      state.message = "Only host can start a new network game.";
      render();
      return;
    }
    initBoard();
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
  elements.save.addEventListener("click", () => {
    saveStateToStorage();
    state.message = "Game saved.";
    render();
  });
  elements.load.addEventListener("click", loadStateFromStorage);
  elements.copyInvite.addEventListener("click", async () => {
    try {
      await createRoomAndConnect();
      await copySignalOutput("Room link copied. Send it to Player (Guest).");
    } catch (error) {
      state.message = error.message || "Failed to create room.";
      render();
    }
  });
  elements.joinLink.addEventListener("click", handleJoinLink);
  elements.signalInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleJoinLink();
    }
  });
  document.addEventListener("keydown", handleKeyboardShortcut);
}

setupListeners();
initBoard();
void prefillSignalFromQuery();
render();
