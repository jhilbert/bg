const POINTS = 24;
const TOTAL_CHECKERS = 15;
const STORAGE_KEY = "bg-save";
const AI_MOVE_TOTAL_MS = 3000;
const AI_MOVE_MIN_STEP_MS = 450;
const COMMIT_VERSION = "e325be3";
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
  remoteSyncInProgress: false,
  lastSyncedPayload: "",
};

const rtc = {
  pc: null,
  channel: null,
  role: null,
  connected: false,
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
  gameMode: document.getElementById("game-mode"),
  networkPanel: document.getElementById("network-panel"),
  networkStatus: document.getElementById("network-status"),
  copyInvite: document.getElementById("copy-invite"),
  joinLink: document.getElementById("join-link"),
  disconnectPeer: document.getElementById("disconnect-peer"),
  signalInput: document.getElementById("signal-input"),
  signalOutput: document.getElementById("signal-output"),
  commitVersion: document.getElementById("commit-version"),
};

function otherSide(side) {
  return side === "player" ? "ai" : "player";
}

function capitalizeSide(side) {
  if (state.gameMode === "p2p") {
    return side === "player" ? "Host" : "Guest";
  }
  return capitalize(side);
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
  state.message = `${capitalizeSide(state.turn)} rolled ${state.dice.join(", ")}.`;
  render();

  if (!hasAnyLegalMoves(state, state.turn, state.remainingDice)) {
    state.message = `${capitalizeSide(state.turn)} rolled ${state.dice.join(
      ", ",
    )} but has no legal moves. Turn passes.`;
    state.dice = [];
    state.diceOwners = [];
    state.remainingDice = [];
    state.turn = otherSide(state.turn);
    state.awaitingRoll = true;
    render();
    syncGameStateToPeer();
    if (isAiControlledTurn()) {
      setTimeout(rollForTurn, 500);
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
  state.message = `Opening roll: Player ${playerDie}, AI ${aiDie}. ${capitalizeSide(winner)} starts.`;
  render();
  syncGameStateToPeer();

  if (!hasAnyLegalMoves(state, winner, state.remainingDice)) {
    state.message += ` No legal opening moves. Turn passes to ${capitalizeSide(otherSide(winner))}.`;
    state.dice = [];
    state.diceOwners = [];
    state.remainingDice = [];
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
    : capitalizeSide(state.turn);
  if (elements.subtitle) {
    elements.subtitle.textContent =
      state.gameMode === "p2p" ? "Online peer-to-peer match" : "Single-player vs. the computer";
  }
  if (elements.playerTitle) {
    elements.playerTitle.textContent = state.gameMode === "p2p" ? "Player (Host)" : "Player";
  }
  if (elements.opponentTitle) {
    elements.opponentTitle.textContent = state.gameMode === "p2p" ? "Player (Guest)" : "Computer";
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
    elements.commitVersion.textContent = `v${COMMIT_VERSION}`;
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
  if (elements.gameMode) {
    elements.gameMode.value = state.gameMode;
  }
  if (elements.networkPanel) {
    elements.networkPanel.hidden = state.gameMode !== "p2p";
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
      label.textContent = row === "top" ? "AI BAR" : "PLAYER BAR";
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
      state.lastMoveSnapshot = createSnapshot(state);
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

  state.lastMoveSnapshot = createSnapshot(state);
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
  if (rtc.connected) {
    elements.networkStatus.textContent = `Connected (${rtc.role || "peer"}).`;
    return;
  }
  if (rtc.role === "host" && rtc.pc) {
    elements.networkStatus.textContent = "Invite created. Waiting for your opponent.";
    return;
  }
  if (rtc.role === "guest" && rtc.pc) {
    elements.networkStatus.textContent = "Return link created. Waiting for host.";
    return;
  }
  elements.networkStatus.textContent = "No active session.";
}

function toBase64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4 !== 0) {
    normalized += "=";
  }
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeSignalDescriptor(descriptor) {
  return toBase64Url(JSON.stringify(descriptor));
}

function decodeSignalDescriptor(encoded) {
  const parsed = JSON.parse(fromBase64Url(encoded));
  if (!parsed || typeof parsed.type !== "string" || typeof parsed.sdp !== "string") {
    throw new Error("Invalid signal payload.");
  }
  return parsed;
}

function buildSignalUrl(type, descriptor) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set(type, encodeSignalDescriptor(descriptor));
  return url.toString();
}

function parseSignalInput(rawValue) {
  const value = rawValue.trim();
  if (!value) return null;

  const parseParams = (params) => {
    const offer = params.get("offer");
    const answer = params.get("answer");
    if (offer) {
      return { kind: "offer", descriptor: decodeSignalDescriptor(offer) };
    }
    if (answer) {
      return { kind: "answer", descriptor: decodeSignalDescriptor(answer) };
    }
    return null;
  };

  try {
    if (value.includes("://")) {
      const params = new URL(value).searchParams;
      const parsed = parseParams(params);
      if (parsed) return parsed;
    }
  } catch (error) {
    // fall through to alternate parsing
  }

  if (value.startsWith("?")) {
    const parsed = parseParams(new URLSearchParams(value.slice(1)));
    if (parsed) return parsed;
  }

  if (value.startsWith("offer=") || value.startsWith("answer=") || value.includes("&")) {
    const parsed = parseParams(new URLSearchParams(value));
    if (parsed) return parsed;
  }

  try {
    const descriptor = JSON.parse(value);
    if (descriptor?.type && descriptor?.sdp) {
      return { kind: descriptor.type === "offer" ? "offer" : "answer", descriptor };
    }
  } catch (error) {
    // ignore and continue
  }

  throw new Error("Could not parse link. Use the invite/return link with ?offer=... or ?answer=...");
}

function waitForIceGatheringComplete(pc, timeoutMs = 12000) {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      clearTimeout(timeout);
      resolve();
    };
    const onStateChange = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const timeout = setTimeout(finish, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onStateChange);
  });
}

function clearPeerSession() {
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
    rtc.pc.close();
  }
  rtc.pc = null;
  rtc.channel = null;
  rtc.role = null;
  rtc.connected = false;
  rtc.generatedSignal = "";
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
  clearPeerSession();
  rtc.role = role;
  rtc.pc = new RTCPeerConnection(RTC_CONFIG);
  rtc.pc.onconnectionstatechange = () => {
    if (!rtc.pc) return;
    if (rtc.pc.connectionState === "connected") {
      rtc.connected = true;
    }
    if (rtc.pc.connectionState === "failed" || rtc.pc.connectionState === "closed") {
      rtc.connected = false;
    }
    updateNetworkStatus();
    render();
  };
  rtc.pc.ondatachannel = (event) => {
    attachDataChannel(event.channel);
  };
  return rtc.pc;
}

async function createOfferSignal() {
  state.gameMode = "p2p";
  state.localSide = "player";
  const pc = createPeerConnection("host");
  const channel = pc.createDataChannel("bg-state");
  attachDataChannel(channel);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);

  const url = buildSignalUrl("offer", pc.localDescription);
  rtc.generatedSignal = url;
  if (elements.signalOutput) {
    elements.signalOutput.value = url;
  }
  state.message = "Invite link created. Share it with your opponent.";
  updateNetworkStatus("Invite created. Waiting for your opponent.");
  render();
}

async function acceptOfferSignal(descriptor) {
  state.gameMode = "p2p";
  state.localSide = "ai";
  const pc = createPeerConnection("guest");
  await pc.setRemoteDescription(descriptor);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGatheringComplete(pc);

  const url = buildSignalUrl("answer", pc.localDescription);
  rtc.generatedSignal = url;
  if (elements.signalOutput) {
    elements.signalOutput.value = url;
  }
  state.message = "Return link created. Send it back to the host.";
  updateNetworkStatus("Return link created. Waiting for host.");
  render();
}

async function acceptAnswerSignal(descriptor) {
  if (!rtc.pc || rtc.role !== "host") {
    throw new Error("Create an offer first, then apply the answer.");
  }
  await rtc.pc.setRemoteDescription(descriptor);
  state.message = "Return link applied. Waiting for peer connection.";
  updateNetworkStatus("Connecting...");
  render();
}

function disconnectPeerSession() {
  clearPeerSession();
  if (elements.signalOutput) {
    elements.signalOutput.value = "";
  }
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
    await navigator.clipboard.writeText(code);
    state.message = successMessage || "Link copied.";
  } catch (error) {
    state.message = "Clipboard copy failed. Copy manually.";
  }
  render();
  return true;
}

async function handleJoinLink() {
  try {
    const parsed = parseSignalInput(elements.signalInput?.value || "");
    if (!parsed) return;
    if (parsed.kind === "offer") {
      await acceptOfferSignal(parsed.descriptor);
      await copySignalOutput("Return link copied. Send it back to the host.");
    } else {
      await acceptAnswerSignal(parsed.descriptor);
    }
  } catch (error) {
    state.message = error.message || "Failed to apply signal.";
    render();
  }
}

function switchGameMode(mode) {
  if (mode === state.gameMode) {
    render();
    return;
  }
  if (mode === "p2p") {
    state.gameMode = "p2p";
    state.localSide = "player";
    state.message = "Online PvP mode enabled. Create an invite or paste one to join.";
    render();
    return;
  }
  disconnectPeerSession();
  state.gameMode = "ai";
  state.localSide = "player";
  initBoard();
}

function prefillSignalFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const offer = params.get("offer");
  const answer = params.get("answer");
  if (!offer && !answer) return;

  state.gameMode = "p2p";
  if (elements.gameMode) {
    elements.gameMode.value = "p2p";
  }
  if (elements.signalInput) {
    elements.signalInput.value = window.location.search;
  }
  state.message = offer
    ? "Invite link detected. Click Paste Link and Join to join."
    : "Return link detected. Host: click Paste Link and Join.";
}

function handleKeyboardShortcut(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  const isEditable =
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT");
  if (isEditable) return;

  const key = event.key.toLowerCase();
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
      state.lastMoveSnapshot = null;
      state.message = "Last move undone.";
      render();
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
    state.lastMoveSnapshot = null;
    state.message = "Last move undone.";
    render();
    syncGameStateToPeer();
  });
  elements.save.addEventListener("click", () => {
    saveStateToStorage();
    state.message = "Game saved.";
    render();
  });
  elements.load.addEventListener("click", loadStateFromStorage);
  elements.gameMode.addEventListener("change", (event) => {
    switchGameMode(event.target.value);
  });
  elements.copyInvite.addEventListener("click", async () => {
    try {
      await createOfferSignal();
      await copySignalOutput("Invite link copied. Send it to your opponent.");
    } catch (error) {
      state.message = error.message || "Failed to create offer.";
      render();
    }
  });
  elements.joinLink.addEventListener("click", handleJoinLink);
  elements.disconnectPeer.addEventListener("click", disconnectPeerSession);
  document.addEventListener("keydown", handleKeyboardShortcut);
}

setupListeners();
initBoard();
prefillSignalFromQuery();
render();
