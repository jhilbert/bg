const POINTS = 24;
const TOTAL_CHECKERS = 15;
const STORAGE_KEY = "bg-save";

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
};

const elements = {
  topRow: document.getElementById("top-row"),
  bottomRow: document.getElementById("bottom-row"),
  board: document.getElementById("board"),
  dice: document.getElementById("dice"),
  turnLabel: document.getElementById("turn-label"),
  playerOff: document.getElementById("player-off"),
  aiOff: document.getElementById("ai-off"),
  hint: document.getElementById("hint"),
  newGame: document.getElementById("new-game"),
  endTurn: document.getElementById("end-turn"),
  bearOff: document.getElementById("bear-off"),
  save: document.getElementById("save"),
  load: document.getElementById("load"),
};

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
  state.message = "Click the dice to roll.";
  render();
}

function rollDie() {
  return Math.floor(Math.random() * 6) + 1;
}

function rollForTurn() {
  state.awaitingRoll = false;
  const die1 = rollDie();
  const die2 = rollDie();
  state.dice = die1 === die2 ? [die1, die1, die1, die1] : [die1, die2];
  state.remainingDice = [...state.dice];
  state.message = `${capitalize(state.turn)} rolled ${state.dice.join(", ")}.`;
  render();

  if (state.turn === "ai") {
    setTimeout(runAiTurn, 500);
  }
}

function render() {
  elements.topRow.innerHTML = "";
  elements.bottomRow.innerHTML = "";

  const topPoints = buildPointOrder("top");
  const bottomPoints = buildPointOrder("bottom");

  renderRow(elements.topRow, topPoints, "top");
  renderRow(elements.bottomRow, bottomPoints, "bottom");

  renderDice();
  elements.turnLabel.textContent = capitalize(state.turn);
  elements.playerOff.textContent = state.off.player;
  elements.aiOff.textContent = state.off.ai;
  elements.hint.textContent = state.message;
  elements.dice.classList.toggle(
    "awaiting",
    state.turn === "player" && state.awaitingRoll,
  );

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
  points.forEach((point, index) => {
    if (point === "bar") {
      const bar = document.createElement("div");
      bar.className = "bar";
      bar.dataset.bar = row === "top" ? "ai" : "player";

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
  if (state.turn === "player" && state.awaitingRoll) {
    const placeholder = document.createElement("div");
    placeholder.className = "die placeholder";
    placeholder.textContent = "Roll";
    elements.dice.appendChild(placeholder);
    return;
  }
  const remainingCounts = state.remainingDice.reduce((acc, die) => {
    acc[die] = (acc[die] || 0) + 1;
    return acc;
  }, {});

  state.dice.forEach((die) => {
    const dieEl = document.createElement("div");
    dieEl.className = "die";
    if (!remainingCounts[die]) {
      dieEl.classList.add("used");
    } else {
      remainingCounts[die] -= 1;
    }
    dieEl.textContent = die;
    elements.dice.appendChild(dieEl);
  });
}

function handleBoardClick(event) {
  if (state.turn !== "player") return;
  if (state.awaitingRoll) {
    state.message = "Roll the dice to start your turn.";
    render();
    return;
  }
  const pointEl = event.target.closest(".point");
  const barEl = event.target.closest(".bar");

  if (barEl && barEl.dataset.bar === "player") {
    if (state.bar.player > 0) {
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
    const move = findLegalMove("player", state.selectedFrom, { type: "point", index });
    if (move) {
      applyMove(state, "player", move);
      consumeDie(move.die);
      state.selectedFrom = null;
      state.message = "Move made.";
      if (checkWin("player")) return;
      if (state.remainingDice.length === 0) endTurn();
      render();
    }
    return;
  }

  if (state.board[index] > 0) {
    state.selectedFrom = { type: "point", index };
    state.message = "Selected checker.";
    render();
  }
}

function consumeDie(die) {
  const idx = state.remainingDice.indexOf(die);
  if (idx >= 0) state.remainingDice.splice(idx, 1);
}

function handleBearOff() {
  if (state.turn !== "player") return;
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

  const move = findLegalMove("player", state.selectedFrom, { type: "off" });
  if (!move) {
    state.message = "No legal bear off with remaining dice.";
    render();
    return;
  }

  applyMove(state, "player", move);
  consumeDie(move.die);
  state.selectedFrom = null;
  state.message = "Checker borne off.";
  if (checkWin("player")) return;
  if (state.remainingDice.length === 0) endTurn();
  render();
}

function endTurn() {
  if (state.turn !== "player") return;
  if (state.awaitingRoll) {
    state.message = "Roll the dice before ending your turn.";
    render();
    return;
  }
  state.selectedFrom = null;
  state.turn = "ai";
  rollForTurn();
}

function runAiTurn() {
  if (state.turn !== "ai") return;
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
  bestMoves.forEach((move) => {
    applyMove(state, "ai", move);
  });
  state.remainingDice = [];
  state.message = `AI rolled ${state.dice.join(", ")}. Moves: ${moveSummary}.`;
  highlightAiMoves(bestMoves);
  if (checkWin("ai")) return;
  startPlayerTurn();
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
    filtered = filtered.filter((seq) => seq.moves[0].die === high);
  }

  return filtered;
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

  if (!anyMove) {
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
  return count + barCount === TOTAL_CHECKERS;
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
  for (const die of state.remainingDice) {
    const moves = getLegalMoves(state, player, die);
    const match = moves.find((move) => matchMove(move, from, to));
    if (match) return match;
  }
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

function evaluateState(currentState) {
  const aiOffScore = currentState.off.ai * 100;
  const playerOffScore = currentState.off.player * -100;
  const barScore = currentState.bar.player * 12 - currentState.bar.ai * 10;
  let blotScore = 0;
  let pointScore = 0;

  for (let i = 0; i < POINTS; i += 1) {
    const val = currentState.board[i];
    if (val === -1) blotScore -= 4;
    if (val === 1) blotScore += 3;
    if (val <= -2) pointScore += 2;
    if (val >= 2) pointScore -= 1;
  }

  return aiOffScore + playerOffScore + barScore + blotScore + pointScore;
}

function checkWin(player) {
  if (state.off[player] >= TOTAL_CHECKERS) {
    state.message = `${capitalize(player)} wins! Start a new game to play again.`;
    render();
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
  state.selectedFrom = null;
  state.dice = [];
  state.remainingDice = [];
  state.awaitingRoll = true;
  state.message += " Your turn—click the dice to roll.";
  render();
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

function highlightAiMoves(moves) {
  const from = new Set();
  const to = new Set();
  moves.forEach((move) => {
    if (typeof move.from === "number") {
      from.add(move.from);
    }
    if (typeof move.to === "number") {
      to.add(move.to);
    }
  });
  state.aiMoveHighlights = { from: [...from], to: [...to] };
  setTimeout(() => {
    state.aiMoveHighlights = { from: [], to: [] };
    render();
  }, 900);
}

function saveStateToStorage() {
  const payload = {
    board: state.board,
    bar: state.bar,
    off: state.off,
    turn: state.turn,
    dice: state.dice,
    remainingDice: state.remainingDice,
    awaitingRoll: state.awaitingRoll,
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
  state.dice = payload.dice;
  state.remainingDice = payload.remainingDice;
  state.awaitingRoll =
    payload.awaitingRoll ?? (state.turn === "player" && state.remainingDice.length === 0);
  state.selectedFrom = null;
  state.message = "Loaded saved game.";
  render();
}

function setupListeners() {
  elements.board.addEventListener("click", handleBoardClick);
  elements.dice.addEventListener("click", () => {
    if (state.turn !== "player" || !state.awaitingRoll) return;
    rollForTurn();
  });
  elements.newGame.addEventListener("click", initBoard);
  elements.bearOff.addEventListener("click", handleBearOff);
  elements.endTurn.addEventListener("click", () => {
    state.message = "Turn ended.";
    endTurn();
  });
  elements.save.addEventListener("click", () => {
    saveStateToStorage();
    state.message = "Game saved.";
    render();
  });
  elements.load.addEventListener("click", loadStateFromStorage);
}

setupListeners();
initBoard();
