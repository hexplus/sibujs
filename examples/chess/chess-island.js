// ---------------------------------------------------------------------------
// Chess — the SibuJS islands reference application.
//
// No build step for this file: it is loaded as a plain ES module and imports
// the package's own `dist/` entry points. The only thing that was bundled is
// the third-party rules engine (`vendor/chess.js`, see
// `scripts/build-example-chess.mjs`).
//
// THE ARCHITECTURAL BOUNDARY THIS EXISTS TO SHOW
// ----------------------------------------------
//   chess.js  owns the rules and the mutable game state.
//   SibuJS    owns DOM enhancement, reactivity, lifecycle and UI behaviour.
//
// SibuJS cannot see a write into `game`. It does not try to. `external()` is
// the seam: consumers say "I read the engine" (`track`), the mutation site says
// "the engine changed" (`invalidate`).
//
// THREE STATE ARCHITECTURES, DELIBERATELY SIDE BY SIDE
// ---------------------------------------------------
//   1. `position` — ONE invalidation domain for the whole engine. Every move
//      re-reads all 64 piece glyphs plus status, history and captures. Simple,
//      and for 64 cells it is measurably fast (see bench/islands-dx.mjs).
//   2. `marks`    — ONE SIGNAL PER SQUARE for selection / legal-target /
//      last-move / check highlighting. This is the hot path: it changes on
//      every click, not every move. Writing all 64 marks is a no-op for the
//      squares whose value did not change, so a click re-runs ~2–30 bindings
//      instead of 64.
//   3. `clock`    — a SECOND invalidation domain, on its own timer. It ticks
//      once a second and touches exactly one binding; the board never hears
//      about it.
//
// docs/architecture/external-state.md explains when each is worth it.
// ---------------------------------------------------------------------------

import {
  batch,
  div,
  dispose,
  each,
  external,
  li,
  mount,
  mountIslands,
  ol,
  p,
  registerIsland,
  signal,
  when,
} from "../../dist/index.js";
import { machine } from "../../dist/patterns.js";
import { createDialogAria, createFocusManager } from "../../dist/ui.js";
import { Chess, SQUARES } from "./vendor/chess.js";

const GLYPH = {
  wp: "♙", wn: "♘", wb: "♗", wr: "♖", wq: "♕", wk: "♔",
  bp: "♟", bn: "♞", bb: "♝", br: "♜", bq: "♛", bk: "♚",
};
const NAME = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"];

const side = (color) => (color === "w" ? "White" : "Black");

// ---------------------------------------------------------------------------
// Feature-local state.
//
// Created INSIDE the island setup, so two boards on one page share nothing.
// There is no module-level game, no global store, no registry keyed by id —
// which is the entire reason two independent boards work without a line of
// code that knows there are two.
// ---------------------------------------------------------------------------
function createChessFeature() {
  const game = new Chess();

  const position = external({ name: "chess:position" });
  const clock = external({ name: "chess:clock" });

  const marks = new Map(SQUARES.map((sq) => [sq, signal("")]));
  const [selected, setSelected] = signal(null);
  const [flipped, setFlipped] = signal(false);
  const [message, setMessage] = signal("");

  let startedAt = Date.now();
  let elapsed = 0;

  /** Legal destinations from the currently selected square. */
  let targets = new Map();

  function lastMove() {
    const history = game.history({ verbose: true });
    return history.length > 0 ? history[history.length - 1] : null;
  }

  function checkedKingSquare() {
    if (!game.inCheck()) return null;
    const turn = game.turn();
    for (const sq of SQUARES) {
      const piece = game.get(sq);
      if (piece && piece.type === "k" && piece.color === turn) return sq;
    }
    return null;
  }

  /**
   * Recompute every square's highlight marks and write only the ones that
   * changed. Signal equality does the filtering: writing the same string back
   * notifies nobody, so a click that moves a highlight from one square to
   * another wakes two bindings, not sixty-four.
   */
  function refreshMarks() {
    const from = selected();
    const last = lastMove();
    const checked = checkedKingSquare();

    batch(() => {
      for (const sq of SQUARES) {
        const parts = [];
        if (sq === from) parts.push("selected");
        if (targets.has(sq)) parts.push(game.get(sq) ? "capture" : "legal");
        if (last && (last.from === sq || last.to === sq)) parts.push("last");
        if (sq === checked) parts.push("check");
        marks.get(sq)[1](parts.join(" "));
      }
    });
  }

  function clearSelection() {
    targets = new Map();
    setSelected(null);
    refreshMarks();
  }

  function selectSquare(sq) {
    const piece = game.get(sq);
    if (!piece || piece.color !== game.turn()) return false;
    targets = new Map(game.moves({ square: sq, verbose: true }).map((move) => [move.to, move]));
    setSelected(sq);
    refreshMarks();
    return true;
  }

  /** Apply a legal move and publish the engine change exactly once. */
  function commit(move, promotion) {
    const played = game.move({ from: move.from, to: move.to, promotion: promotion ?? undefined });
    targets = new Map();
    setSelected(null);
    batch(() => {
      position.invalidate();
      setMessage(describe(played));
    });
    refreshMarks();
    return played;
  }

  function describe(move) {
    if (game.isCheckmate()) return `Checkmate — ${side(move.color)} wins`;
    if (game.isStalemate()) return "Stalemate";
    if (game.isDraw()) return "Draw";
    if (game.inCheck()) return `${side(game.turn())} is in check`;
    if (move.promotion) return `Pawn promoted to ${NAME[move.promotion]}`;
    if (move.captured) return `${side(move.color)} takes ${NAME[move.captured]}`;
    return `${side(move.color)} plays ${move.san}`;
  }

  function undo() {
    const undone = game.undo();
    if (!undone) {
      setMessage("Nothing to undo");
      return;
    }
    targets = new Map();
    setSelected(null);
    batch(() => {
      position.invalidate();
      setMessage(`Took back ${undone.san}`);
    });
    refreshMarks();
  }

  function reset() {
    game.reset();
    targets = new Map();
    setSelected(null);
    startedAt = Date.now();
    elapsed = 0;
    batch(() => {
      position.invalidate();
      clock.invalidate();
      setMessage("New game");
    });
    refreshMarks();
  }

  function tick() {
    elapsed = Date.now() - startedAt;
    clock.invalidate();
  }

  function clockText() {
    clock.track();
    const total = Math.floor(elapsed / 1000);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }

  function statusText() {
    position.track();
    if (game.isCheckmate()) return `${side(game.turn() === "w" ? "b" : "w")} wins by checkmate`;
    if (game.isStalemate()) return "Stalemate — draw";
    if (game.isInsufficientMaterial()) return "Draw — insufficient material";
    if (game.isThreefoldRepetition()) return "Draw — threefold repetition";
    if (game.isDraw()) return "Draw";
    return `${side(game.turn())} to move`;
  }

  function historyRows() {
    position.track();
    const history = game.history();
    const rows = [];
    for (let i = 0; i < history.length; i += 2) {
      rows.push({ n: i / 2 + 1, white: history[i], black: history[i + 1] ?? "" });
    }
    return rows;
  }

  function capturedBy(color) {
    position.track();
    const taken = game
      .history({ verbose: true })
      .filter((move) => move.color === color && move.captured)
      .map((move) => GLYPH[`${color === "w" ? "b" : "w"}${move.captured}`]);
    return taken.length > 0 ? taken.join(" ") : "none";
  }

  function labelFor(sq) {
    position.track();
    const piece = game.get(sq);
    return piece ? `${sq}, ${side(piece.color)} ${NAME[piece.type]}` : `${sq}, empty`;
  }

  function glyphFor(sq) {
    position.track();
    const piece = game.get(sq);
    return piece ? GLYPH[`${piece.color}${piece.type}`] : "";
  }

  return {
    marks,
    selected,
    flipped,
    setFlipped,
    message,
    targets: () => targets,
    selectSquare,
    clearSelection,
    commit,
    undo,
    reset,
    tick,
    clockText,
    statusText,
    historyRows,
    capturedBy,
    labelFor,
    glyphFor,
    isGameOver: () => game.isGameOver(),
  };
}

// ---------------------------------------------------------------------------
// The island setup. Everything below runs once per board element.
// ---------------------------------------------------------------------------
function setupChess(ctx) {
  const feature = createChessFeature();

  // -- the interaction state machine ---------------------------------------
  //
  // The required path is idle → piece-selected → promotion-required →
  // promotion-selected → move-committed → idle, plus cancellation. `machine`
  // ignores an event a state does not declare, so an invalid transition (a
  // second CHOOSE, a stray COMMIT) is a no-op rather than a double move — which
  // is what makes "commit exactly once" a property of the state, not of a flag
  // somebody has to remember to reset.
  const flow = machine({
    initial: "idle",
    states: {
      idle: { on: { SELECT: "piece-selected" } },
      "piece-selected": {
        on: { SELECT: "piece-selected", CLEAR: "idle", PLAY: "move-committed", PROMOTE: "promotion-required" },
      },
      // CANCEL returns to "piece-selected", not to "idle": the piece IS still
      // selected, and a machine state that disagreed with what the board is
      // showing would be a second source of truth waiting to drift.
      "promotion-required": { on: { CHOOSE: "promotion-selected", CANCEL: "piece-selected" } },
      "promotion-selected": { on: { COMMIT: "move-committed" } },
      "move-committed": { on: { DONE: "idle" } },
    },
  });

  /** The move waiting for a promotion choice, and the square to refocus. */
  let pending = null;
  let returnFocusTo = null;

  // -- promotion dialog ------------------------------------------------------
  const dialogEl = ctx.ref("@promotion");
  const dialogTitle = ctx.ref("@promotion-title");
  const dialogDesc = ctx.ref("@promotion-desc");
  // Ids are generated, not written in the server HTML, so two boards on one
  // page cannot collide on `aria-labelledby`.
  const dialogAria = createDialogAria(dialogEl, { modal: true });
  dialogTitle.id = dialogAria.titleId;
  dialogDesc.id = dialogAria.descriptionId;
  const dialogFocus = createFocusManager(dialogEl);

  const isPromoting = () => flow.matches("promotion-required");

  function openPromotion(move, originSquare) {
    pending = move;
    returnFocusTo = originSquare;
    flow.send("PROMOTE");
    // Focus moves after the binding has revealed the dialog. `ctx.show` writes
    // synchronously, so the element is already focusable here.
    dialogFocus.focusFirst();
  }

  function closePromotion(event) {
    pending = null;
    flow.send(event);
    // Focus returns to the square whose activation opened the dialog — after a
    // cancel as well as after a commit, so a keyboard user is never dropped at
    // the top of the page with nothing focused.
    if (returnFocusTo && returnFocusTo.isConnected) returnFocusTo.focus();
    returnFocusTo = null;
  }

  function choosePromotion(piece) {
    // Guarded by the machine: a second click (or a click racing the keyboard)
    // finds a state with no CHOOSE transition and does nothing.
    if (!isPromoting() || !pending) return;
    flow.send("CHOOSE");
    const move = pending;
    closePromotion("COMMIT");
    feature.commit(move, piece);
    flow.send("DONE");
  }

  ctx.show(dialogEl, isPromoting);
  ctx.attr(dialogEl, "aria-hidden", () => (isPromoting() ? null : "true"));

  ctx.each("@promote", (button) => ({
    on: { click: () => choosePromotion(button.dataset.piece) },
  }));
  ctx.on("@promotion-cancel", "click", () => {
    if (isPromoting()) closePromotion("CANCEL");
  });

  // Modal behaviour: Escape cancels, Tab cycles inside the dialog. Both are
  // scoped to the dialog element, so nothing global is installed and two boards
  // never fight over the keyboard.
  ctx.on(dialogEl, "keydown", (event) => {
    if (!isPromoting()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePromotion("CANCEL");
      return;
    }
    if (event.key !== "Tab") return;
    const items = dialogFocus.items();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  // -- the board: 64 server-rendered squares, enhanced in place --------------
  function activate(squareEl) {
    const sq = squareEl.dataset.square;
    if (feature.isGameOver() || isPromoting()) return;

    const from = feature.selected();
    const move = from ? feature.targets().get(sq) : null;

    if (move) {
      if (move.promotion) {
        openPromotion(move, squareEl);
        return;
      }
      flow.send("PLAY");
      feature.commit(move);
      flow.send("DONE");
      return;
    }

    if (from === sq) {
      feature.clearSelection();
      flow.send("CLEAR");
      return;
    }

    if (feature.selectSquare(sq)) flow.send("SELECT");
    else {
      feature.clearSelection();
      flow.send("CLEAR");
    }
  }

  const squares = ctx.refs("@square");
  const byName = new Map(squares.map((el) => [el.dataset.square, el]));

  ctx.each("@square", (squareEl) => {
    const sq = squareEl.dataset.square;
    const [marks] = feature.marks.get(sq);

    return {
      // Granular: one signal per square, so a selection change wakes only the
      // squares whose highlight actually changed.
      attr: {
        "data-marks": () => marks(),
        "aria-label": () => feature.labelFor(sq),
        "aria-selected": () => feature.selected() === sq,
      },
      on: {
        click: () => activate(squareEl),
        keydown: (event) => onSquareKey(event, sq),
        focus: () => setRovingFocus(sq),
      },
    };
  });

  // The piece glyph is a separate node from the button, so the button's
  // `aria-label` and the glyph never fight over the same text content.
  ctx.each("@piece", (pieceEl) => {
    const sq = pieceEl.closest("[data-square]").dataset.square;
    return { text: () => feature.glyphFor(sq) };
  });

  // -- keyboard navigation ---------------------------------------------------
  //
  // Roving tabindex: exactly one square is in the tab order at a time, and the
  // arrow keys move focus within the grid. Enter/Space need no handler — these
  // are real <button> elements, so the browser turns them into a click.
  let focusSquare = "a8";

  function setRovingFocus(sq) {
    focusSquare = sq;
    for (const [name, el] of byName) el.tabIndex = name === sq ? 0 : -1;
  }

  function step(sq, dFile, dRank) {
    const flip = feature.flipped() ? -1 : 1;
    const file = FILES.indexOf(sq[0]) + dFile * flip;
    const rank = RANKS.indexOf(sq[1]) + dRank * flip;
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    return `${FILES[file]}${RANKS[rank]}`;
  }

  function moveFocus(next) {
    if (!next) return;
    const el = byName.get(next);
    if (!el) return;
    setRovingFocus(next);
    el.focus();
  }

  function onSquareKey(event, sq) {
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        moveFocus(step(sq, 1, 0));
        break;
      case "ArrowLeft":
        event.preventDefault();
        moveFocus(step(sq, -1, 0));
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(step(sq, 0, 1));
        break;
      case "ArrowDown":
        event.preventDefault();
        moveFocus(step(sq, 0, -1));
        break;
      case "Home":
        event.preventDefault();
        moveFocus(`a${sq[1]}`);
        break;
      case "End":
        event.preventDefault();
        moveFocus(`h${sq[1]}`);
        break;
      case "Escape":
        event.preventDefault();
        feature.clearSelection();
        flow.send("CLEAR");
        break;
      default:
        break;
    }
  }

  // -- status, clock, trays --------------------------------------------------
  ctx.text("@status", () => {
    const note = feature.message();
    return note ? `${feature.statusText()} · ${note}` : feature.statusText();
  });
  ctx.text("@clock", feature.clockText);
  ctx.text("@captured-w", () => feature.capturedBy("w"));
  ctx.text("@captured-b", () => feature.capturedBy("b"));
  ctx.classed("@board", "flipped", feature.flipped);

  ctx.on("@undo", "click", () => {
    if (isPromoting()) return;
    feature.undo();
  });
  ctx.on("@flip", "click", () => feature.setFlipped((value) => !value));
  ctx.on("@reset", "click", () => {
    if (isPromoting()) closePromotion("CANCEL");
    feature.reset();
  });

  // -- the dynamic subregion: mount(), not enhance() -------------------------
  //
  // The server cannot know how many rows a game will have, so this is the one
  // region SibuJS creates. `when` swaps between an empty state and the list —
  // it CREATES and DESTROYS nodes, which is exactly why it belongs on the
  // mounted side; `ctx.show` above toggles a node that already exists, which is
  // why it belongs on the enhanced side.
  const historySlot = ctx.ref("@history");
  historySlot.textContent = "";
  //
  // `when` inserts its branch as a SIBLING of its anchor, so the anchor is
  // wrapped in an element the mount owns. Unmounting then removes the wrapper —
  // anchor and branch together — instead of leaving the branch behind.
  const history = mount(
    () =>
      div(
        { class: "history" },
        when(
          () => feature.historyRows().length > 0,
          () =>
            ol(
              { class: "moves", "data-ref": "moves" },
              each(
                feature.historyRows,
                (row) => li({ class: "move" }, () => `${row().n}. ${row().white} ${row().black}`.trim()),
                { key: (row) => row.n },
              ),
            ),
          () => p({ class: "empty", "data-ref": "moves-empty" }, "No moves yet."),
        ),
      ),
    historySlot,
  );
  // The mounted region is owned by the island: this one line is what makes
  // "dispose the island" mean "dispose the list" too.
  ctx.cleanup(history.unmount);

  // -- the clock: a timer the island owns ------------------------------------
  const timer = setInterval(feature.tick, 1000);
  ctx.cleanup(() => clearInterval(timer));

  setRovingFocus(focusSquare);
}

registerIsland("chess", setupChess);
registerIsland("broken", () => {
  throw new Error("[chess example] this island fails on purpose");
});

const disposeIslands = mountIslands(document);

// A host framework that owns this page would keep this disposer and call it
// before replacing the markup — see docs/interop.md. Exposed here so the
// browser tests can exercise disposal and remounting the way a host would.
window.chessExample = {
  dispose: disposeIslands,
  remount: () => mountIslands(document),
  disposeNode: dispose,
};
