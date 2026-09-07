import { tempoRangeStyle } from './tempo-range.js';

export const controlsStyle = `
        :host {
          font: inherit;
          color: inherit;
          --tempo-fg: #222;
          --tempo-accent: #ff5500;
          --tempo-accent-surface: #242424;
          --tempo-accent-hover: #282828;
          --tempo-track: #888;
        }

        * {
          box-sizing: border-box;
        }

        .controls {
          display: grid;
          grid-template-columns: 56px 20px minmax(0, 1fr) 24px 24px;
          align-items: center;
          gap: 4px;
          width: 100%;
          height: 32px;
          color: var(--tempo-fg);
          font-size: 12px;
        }

        button,
        input {
          font: inherit;
          color: inherit;
        }

        button {
          cursor: pointer;
        }

        button:focus-visible,
        input:focus-visible {
          outline: 2px solid var(--tempo-fg);
          outline-offset: 2px;
        }

        .field {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 2px;
          font-variant-numeric: tabular-nums;
        }

        .field #rate-number {
          text-align: right;
        }

        .field #rate-number:hover {
          background: transparent;
        }

        .unit {
          flex: none;
          line-height: 24px;
        }

        .slider-wrap {
          position: relative;
          min-width: 0;
          height: 32px;
          transform: translateY(var(--tempo-rail-offset, 0px));
        }

        .ticks {
          position: absolute;
          inset: 24px 6px auto;
          width: calc(100% - 12px);
          height: 5px;
          overflow: visible;
          pointer-events: none;
        }

        .ticks path {
          fill: none;
          stroke: var(--tempo-track);
          stroke-width: 1px;
          vector-effect: non-scaling-stroke;
        }

        .ticks .normal-tick {
          stroke: var(--tempo-fg);
        }

        @media (forced-colors: active) {
          .slider-wrap {
            forced-color-adjust: none;
            --tempo-accent: Highlight;
            --tempo-track: GrayText;
            --tempo-fg: CanvasText;
          }
        }

        .settings {
          display: flex;
          flex-direction: column;
          position: fixed;
          inset: auto;
          margin: 0;
          z-index: 2147483647;
          max-height: calc(100dvh - 80px);
          overflow: auto;
          padding: 12px;
          border: 1px solid var(--tempo-track);
          border-radius: 4px;
          background: var(--tempo-surface, #f2f2f2);
          color: var(--tempo-fg);
          font-family: inherit;
          font-size: 12px;
          line-height: 1.5;
        }

        .settings > * {
          flex-shrink: 0;
        }

        .settings header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
        }

        .settings-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .quick-settings {
          display: flex;
          flex-wrap: wrap;
          gap: 4px 20px;
          margin-bottom: 8px;
        }

        .advanced-audio {
          margin: 0;
        }

        .settings summary {
          cursor: pointer;
          padding: 5px 0;
        }

        .settings button {
          min-height: 28px;
          padding: 3px 6px;
          border: 0;
          border-radius: 3px;
          background: transparent;
        }

        .settings button:hover {
          background: color-mix(in srgb, var(--tempo-fg) 10%, transparent);
        }

        .random-label {
          display: flex;
          align-items: center;
          gap: 8px;
          cursor: pointer;
        }

        .settings input[type='checkbox'] {
          accent-color: var(--tempo-accent);
          margin: 0;
        }

        .settings p {
          margin: 6px 0 12px;
        }
        .output-label {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          margin-top: 12px;
        }

        #output-level {
          display: block;
          width: 100%;
          accent-color: var(--tempo-accent);
        }

        .settings input[type='search'] {
          width: 100%;
          padding: 6px;
          border: 1px solid var(--tempo-track);
          border-radius: 3px;
          background: transparent;
        }

        .settings input::placeholder {
          color: var(--tempo-fg);
          opacity: 0.7;
        }

        .saved-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 132px;
          gap: 4px 12px;
          align-items: center;
          padding: 4px 2px;
          border-bottom: 1px solid color-mix(in srgb, var(--tempo-fg) 16%, transparent);
          min-width: 0;
        }

        .saved-list {
          flex: 1 1 auto;
          min-height: 80px;
          max-height: 680px;
          overflow: auto;
          overscroll-behavior: contain;
          scrollbar-gutter: stable;
          scrollbar-width: thin;
          scrollbar-color: var(--tempo-track) transparent;
          padding-right: 6px;
        }

        .saved-list:empty {
          min-height: 0;
        }

        .saved-row:last-child {
          border-bottom: 0;
        }

        .settings .saved-count {
          margin: 6px 0;
        }

        .saved-setting {
          display: grid;
          grid-column: 2;
          grid-template-columns: 28px 64px 28px;
          gap: 6px;
          align-items: center;
        }

        .saved-switch {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 32px;
          cursor: pointer;
        }

        .saved-setting button {
          min-height: 32px;
        }

        .saved-row a {
          grid-column: 1;
          grid-row: 1;
          overflow: hidden;
          color: inherit;
          text-overflow: ellipsis;
          white-space: nowrap;
          text-underline-offset: 3px;
        }

        .saved-row input[type='number'] {
          width: 46px;
          height: 32px;
          border: 0;
        }

        .saved-value {
          display: flex;
          align-items: center;
          justify-content: center;
          border: 1px solid var(--tempo-track);
          border-radius: 3px;
          font-variant-numeric: tabular-nums;
        }

        .saved-remove svg {
          display: block;
          width: 12px;
          height: 12px;
          margin: auto;
          fill: none;
          stroke: currentColor;
          stroke-width: 1.5;
          stroke-linecap: round;
        }

        .settings-tools {
          margin-top: 8px;
          border-top: 1px solid color-mix(in srgb, var(--tempo-fg) 16%, transparent);
          padding-top: 4px;
        }

        .appearance-options {
          display: flex;
          flex-wrap: wrap;
          gap: 4px 16px;
          margin: 0 0 4px;
          padding: 0;
          border: 0;
        }

        .appearance-options label {
          display: flex;
          align-items: center;
          min-height: 32px;
          gap: 6px;
          cursor: pointer;
        }

        .appearance-options input {
          margin: 0;
          accent-color: var(--tempo-accent);
        }

        .library-backup {
          margin: 0;
        }

        .backup-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          margin-block: 10px;
        }

        .backup-preview p {
          margin-block: 8px;
        }

        .saved-more {
          margin-top: 10px;
        }

        @media (max-width: 390px) {
          .saved-row {
            grid-template-columns: minmax(0, 1fr) 118px;
            column-gap: 6px;
          }

          .saved-setting {
            grid-template-columns: 24px 58px 28px;
            gap: 4px;
          }

          .saved-row input[type='number'] {
            width: 42px;
          }
        }

        @media (pointer: coarse) {
          .appearance-options label,
          .saved-setting button,
          .saved-switch,
          .saved-row input[type='number'] {
            min-height: 44px;
          }
        }

        .settings-status:empty {
          display: none;
        }

        input[type='number'] {
          width: 46px;
          min-width: 0;
          height: 24px;
          padding: 0;
          border: 0;
          border-radius: 2px;
          background: transparent;
          text-align: center;
          font-variant-numeric: tabular-nums;
          appearance: textfield;
          -moz-appearance: textfield;
          caret-color: var(--tempo-accent);
        }

        input[type='number']::-webkit-inner-spin-button,
        input[type='number']::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }

        input[type='number']:hover {
          background: color-mix(in srgb, var(--tempo-fg) 8%, transparent);
        }

        .steppers {
          display: grid;
          grid-template-rows: repeat(2, 16px);
        }

        .step {
          display: grid;
          place-items: center;
          width: 20px;
          height: 16px;
          padding: 0;
          border: 0;
          border-radius: 2px;
          background: transparent;
        }

        .step:hover:not(:disabled) {
          color: var(--tempo-accent);
          background: color-mix(in srgb, var(--tempo-fg) 8%, transparent);
        }

        .step:disabled {
          opacity: 0.35;
          cursor: default;
        }

        .step svg {
          width: 10px;
          height: 8px;
          fill: none;
          stroke: currentColor;
          stroke-width: 1.5;
          stroke-linecap: round;
          stroke-linejoin: round;
        }

        @media (max-width: 850px) {
          :host {
            flex-basis: 208px !important;
            min-width: 208px !important;
          }
        }

        input::selection {
          background: var(--tempo-accent);
          color: #fff;
        }

        ${tempoRangeStyle}

        .memory,
        .settings-button {
          display: grid;
          place-items: center;
          width: 24px;
          height: 24px;
          padding: 4px;
          border: 0;
          border-radius: 3px;
          background: transparent;
        }

        .memory:hover,
        .settings-button:hover {
          background: color-mix(in srgb, var(--tempo-fg) 8%, transparent);
        }

        .memory svg,
        .settings-button svg {
          width: 14px;
          height: 14px;
          fill: none;
          stroke: currentColor;
          stroke-width: 1.5;
          stroke-linecap: round;
          stroke-linejoin: round;
        }

        .memory[aria-pressed='true'] {
          color: var(--tempo-accent);
        }

        .memory[data-state='saved'] .bookmark {
          fill: currentColor;
        }

        .memory .update-dot,
        .memory .warning,
        .memory .check {
          display: none;
        }

        .memory[data-state='modified'] .update-dot {
          display: block;
          fill: currentColor;
          stroke: none;
        }

        .memory[data-state='error'] .warning {
          display: block;
        }

        .memory[data-state='error'] .bookmark,
        .memory[data-state='error'] .update-dot {
          display: none;
        }

        .memory:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .memory[data-feedback='saved'] .check {
          display: block;
        }

        .memory[data-feedback='saved'] .bookmark,
        .memory[data-feedback='saved'] .update-dot {
          display: none;
        }

        .error {
          font-weight: 700;
        }

        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip-path: inset(50%);
          white-space: nowrap;
          border: 0;
        }

        [hidden] {
          display: none !important;
        }
      `;
