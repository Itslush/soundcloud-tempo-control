export const editorStyle = `
        .tempo-editor {
          position: fixed;
          margin: 0;
          padding: 16px;
          max-height: calc(100vh - 84px);
          overflow: auto;
          border: 1px solid var(--tempo-track);
          border-radius: 4px;
          background: var(--tempo-surface);
          color: var(--tempo-fg);
          font:
            12px/1.5 Arial,
            sans-serif;
          z-index: 2147483647;
        }
        .tempo-editor[hidden] {
          display: none;
        }
        .tempo-editor header,
        .editor-actions,
        .point-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .tempo-editor header {
          justify-content: space-between;
        }
        .editor-actions {
          justify-content: flex-end;
          margin-top: 16px;
          padding-top: 12px;
          border-top: 1px solid var(--tempo-track);
        }
        .point-actions {
          margin: 8px 0;
        }
        .editor-actions .editor-revert {
          margin-right: auto;
          border-color: transparent;
        }
        .playback-state {
          display: block;
          margin: 4px 0;
        }
        .editor-pitch-label {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 12px 0;
        }
        .tempo-editor .editor-pitch {
          width: auto;
        }
        .editor-sharing .editor-actions {
          border: 0;
          margin: 8px 0;
          padding: 0;
          justify-content: flex-start;
        }
        .editor-sharing label {
          display: block;
          margin-top: 12px;
        }
        .tempo-editor [hidden] {
          display: none !important;
        }
        .tempo-editor input,
        .tempo-editor select,
        .tempo-editor output {
          font-variant-numeric: tabular-nums;
        }
        .tempo-editor header strong {
          font-size: 14px;
        }
        .tempo-editor button {
          min-height: 28px;
          border: 1px solid var(--tempo-track);
          border-radius: 3px;
          background: transparent;
          padding: 4px 10px;
        }
        .tempo-editor button:hover {
          background: color-mix(in srgb, var(--tempo-fg) 8%, transparent);
        }
        .tempo-editor .primary {
          color: var(--tempo-accent);
          border-color: var(--tempo-accent);
          background: var(--tempo-accent-surface);
        }
        .tempo-editor .primary:hover {
          background: var(--tempo-accent-hover);
        }
        .editor-track {
          display: block;
          color: inherit;
          margin: 8px 0;
          overflow-wrap: anywhere;
        }
        .editor-graph {
          width: 100%;
          height: 220px;
          display: block;
          touch-action: none;
          user-select: none;
        }
        .editor-graph text {
          fill: var(--tempo-fg);
          font-size: 11px;
        }
        .editor-graph .grid {
          stroke: var(--tempo-track);
          stroke-width: 0.5;
        }
        .editor-graph .curve {
          stroke: var(--tempo-accent);
          stroke-width: 2.5;
          fill: none;
        }
        .editor-graph .point {
          fill: var(--tempo-surface);
          stroke: var(--tempo-accent);
          stroke-width: 2;
          cursor: grab;
        }
        .editor-graph .selected {
          fill: var(--tempo-accent);
        }
        .editor-graph .ramp {
          cursor: ew-resize;
        }
        .editor-graph .ramp-line {
          stroke: var(--tempo-accent);
          stroke-width: 1.5;
          stroke-dasharray: 3 3;
          pointer-events: none;
        }
        .editor-graph .ramp-label {
          fill: var(--tempo-surface);
          stroke: var(--tempo-accent);
          stroke-width: 1;
        }
        .editor-graph .ramp-arrow {
          stroke: var(--tempo-fg);
          stroke-width: 1.5;
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .editor-graph .ramp text,
        .editor-graph .ramp-arrow {
          pointer-events: none;
        }
        .editor-graph .ramp:hover .ramp-label,
        .editor-graph .ramp:focus-visible .ramp-label {
          stroke: var(--tempo-fg);
          stroke-width: 2;
        }
        .editor-graph .ramp:focus-visible {
          outline: none;
        }
        .editor-fields {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 12px;
          margin: 12px 0;
        }
        .editor-fields label {
          display: grid;
          gap: 4px;
        }
        .tempo-editor .editor-fields input,
        .tempo-editor select,
        .tempo-editor textarea {
          width: 100%;
          height: 30px;
          border: 1px solid var(--tempo-track);
          border-radius: 3px;
          background: var(--tempo-surface);
          color: inherit;
          padding: 4px 6px;
          font: inherit;
        }
        .tempo-editor textarea {
          height: 60px;
          resize: vertical;
          margin: 8px 0;
          overflow-wrap: anywhere;
        }
        .tempo-editor details {
          margin-top: 12px;
        }
        .tempo-editor summary {
          cursor: pointer;
        }
        .editor-status {
          min-height: 18px;
          margin-bottom: 0;
        }
        .editor-toolbar {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          margin: 12px 0 8px;
        }
        .editor-toolbar label {
          display: flex;
          align-items: center;
          gap: 6px;
          white-space: nowrap;
        }
        .editor-toolbar output {
          margin-right: auto;
          font-variant-numeric: tabular-nums;
        }
        .timeline-navigation[hidden] {
          display: none;
        }
        .timeline-navigation {
          margin: 0 0 12px;
          font-variant-numeric: tabular-nums;
        }
        .timeline-navigation .editor-readout {
          margin: 0;
        }
        .editor-pan {
          cursor: ew-resize;
        }
        .editor-pan:active {
          cursor: grabbing;
        }
        .timeline-limits {
          display: flex;
          justify-content: space-between;
          line-height: 1;
        }
        .editor-readout {
          display: flex;
          justify-content: space-between;
          gap: 8px;
          margin: 6px 0;
          font-variant-numeric: tabular-nums;
        }
        .tempo-editor button:disabled {
          opacity: 0.45;
          cursor: default;
        }
        .tempo-editor :focus-visible {
          outline: 2px solid var(--tempo-accent);
          outline-offset: 2px;
        }
        .editor-point-picker {
          max-width: 100%;
        }
        .tempo-editor .editor-enable {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        @media (max-width: 540px) {
          .editor-fields {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
      `;
