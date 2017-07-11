//= require flow-loader
//= link tryFlowWorker
import * as CodeMirror from 'codemirror/lib/codemirror';
import 'codemirror/addon/lint/lint';
import 'codemirror/mode/javascript/javascript';
import 'codemirror/mode/xml/xml';
import 'codemirror/mode/jsx/jsx';
import * as LZString from 'lz-string';
import {load as initFlowLocally} from 'flow-loader';

CodeMirror.defineOption('flow', null, function(editor) {
  editor.performLint();
});

function printError(err, editor) {
  const clickHandler = (msg) => {
    editor.getDoc().setSelection(
      {line: msg.loc.start.line - 1, ch: msg.loc.start.column - 1},
      {line: msg.loc.end.line - 1, ch: msg.loc.end.column}
    );
    editor.focus();
  };

  return err.message.reduce((container, msg) => {
    if (msg.loc && msg.context != null) {
      const div = document.createElement('div');
      const filename = msg.loc.source !== '-' ? `${msg.loc.source}:` : '';
      const prefix = `${filename}${msg.loc.start.line}: `;

      const before = msg.context.slice(0, msg.loc.start.column - 1);
      const highlight = (msg.loc.start.line === msg.loc.end.line) ?
        msg.context.slice(msg.loc.start.column - 1, msg.loc.end.column) :
        msg.context.slice(msg.loc.start.column - 1);
      const after = (msg.loc.start.line === msg.loc.end.line) ?
        msg.context.slice(msg.loc.end.column) :
        '';
      div.appendChild(document.createTextNode(prefix + before));
      const bold = document.createElement('strong');
      bold.className = "msgHighlight";
      bold.appendChild(document.createTextNode(highlight));
      div.appendChild(bold);
      div.appendChild(document.createTextNode(after));
      container.appendChild(div);

      const offset = msg.loc.start.column + prefix.length - 1;
      const arrow = `${(prefix + before).replace(/[^ ]/g, ' ')}^ `;
      container.appendChild(document.createTextNode(arrow));

      const span = document.createElement('span');
      span.className = "msgType";
      span.appendChild(document.createTextNode(msg.descr));
      container.appendChild(span);

      const handler = clickHandler.bind(null, msg);
      bold.addEventListener('click', handler);
      span.addEventListener('click', handler);
    } else {
      const descr = `. ${msg.descr}\n`;
      container.appendChild(document.createTextNode(descr));
    }
    return container;
  }, document.createElement('li'));
}

function printErrors(errors, editor) {
  if (errors.length == 0) {
    return document.createTextNode('No errors!');
  }
  return errors.reduce((list, err) => {
    list.appendChild(printError(err, editor));
    return list;
  }, document.createElement('ul'));
}

function removeChildren(node) {
  while (node.lastChild) node.removeChild(node.lastChild);
}

function getAnnotations(text, callback, options, editor) {
  const flow = editor.getOption('flow');
  Promise.resolve(flow).then(() => {
    var errors = self.flow.checkContent('-', text);

    CodeMirror.signal(editor, 'flowErrors', errors);

    var lint = errors.map(function(err) {
      var messages = err.message;
      var firstLoc = messages[0].loc;
      var message = messages.map(function(msg) {
        return msg.descr;
      }).join("\n");
      return {
        from: CodeMirror.Pos(
          firstLoc.start.line - 1,
          firstLoc.start.column - 1
        ),
        to: CodeMirror.Pos(firstLoc.end.line - 1, firstLoc.end.column),
        severity: err.level,
        message: message
      };
    });
    callback(lint);
  });
}
getAnnotations.async = true;

const lastEditorValue = localStorage.getItem('tryFlowLastContent');
const defaultValue = (lastEditorValue && getHashedValue(lastEditorValue)) || `/* @flow */

function foo(x: ?number): string {
  if (x) {
    return x;
  }
  return "default string";
}
`;

function getHashedValue(hash) {
  if (hash[0] !== '#' || hash.length < 2) return null;
  const version = hash.slice(1, 2);
  const encoded = hash.slice(2);
  if (version === '0' && encoded.match(/^[a-zA-Z0-9+/=_-]+$/)) {
    return LZString.decompressFromEncodedURIComponent(encoded);
  }
  return null;
}

function removeClass(elem, className) {
  elem.className = elem.className.split(/\s+/).filter(function(name) {
    return name !== className;
  }).join(' ');
}

class Deferred {
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

const workerRegistry = {}
class FlowWorker {
  constructor(version) {
    this._version = version;
    this._pending = {};
    this._index = 0;

    const worker = this._worker = new Worker('/assets/tryFlowWorker.js');
    worker.onmessage = ({data}) => {
      if (data.id && this._pending[data.id]) {
        if (data.err) {
          this._pending[data.id].reject(data.err);
        } else {
          this._pending[data.id].resolve(data.result);
        }
        delete this._pending[data.id];
      }
    };
    worker.onerror = function() {
      console.log('There is an error with your worker!');
    };

    // keep a reference to the worker, so that it doesn't get GC'd and killed.
    workerRegistry[version] = worker;
  }

  send(data) {
    const id = ++this._index;
    const version = this._version;
    this._pending[id] = new Deferred();
    this._worker.postMessage({ id, version, ...data });
    return this._pending[id].promise;
  }
}

function initFlowWorker(version) {
  const worker = new FlowWorker(version);
  return worker.send({ type: 'init' }).then(() => worker);
}

class AsyncLocalFlow {
  constructor(flow) {
    this._flow = flow;
  }

  checkContent(filename, body) {
    return Promise.resolve(this._flow.checkContent(filename, body));
  }
}

class AsyncWorkerFlow {
  constructor(worker) {
    this._worker = worker;
  }

  checkContent(filename, body) {
    return this._worker.send({ type: 'checkContent', filename, body });
  }
}

function initFlow(version) {
  const useWorker = localStorage.getItem('tryFlowUseWorker');
  if (useWorker === 'false') {
    return initFlowLocally(version).then((flow) => new AsyncLocalFlow(flow));
  } else {
    return initFlowWorker(version).then((flow) => new AsyncWorkerFlow(flow));
  }
}

function createEditor(
  flowVersion,
  domNode,
  resultsNode,
  flowVersions
) {
  const flowReady = initFlow(flowVersion);

  require([
    'codemirror/addon/lint/lint',
    'codemirror/mode/javascript/javascript',
    'codemirror/mode/xml/xml',
    'codemirror/mode/jsx/jsx'
  ], function() {
    const location = window.location;

    flowReady.then(function() {
      removeClass(resultsNode, 'show-loading');
    });

    const errorsTabNode = document.createElement('li');
    errorsTabNode.className = "tab errors-tab";
    errorsTabNode.appendChild(document.createTextNode('Errors'));
    errorsTabNode.addEventListener('click', function(evt) {
      removeClass(resultsNode, 'show-json');
      removeClass(resultsNode, 'show-ast');
      resultsNode.className += ' show-errors';
      evt.preventDefault();
    });

    const jsonTabNode = document.createElement('li');
    jsonTabNode.className = "tab json-tab";
    jsonTabNode.appendChild(document.createTextNode('JSON'));
    jsonTabNode.addEventListener('click', function(evt) {
      removeClass(resultsNode, 'show-errors');
      removeClass(resultsNode, 'show-ast');
      resultsNode.className += ' show-json';
      evt.preventDefault();
    });

    const astTabNode = document.createElement('li');
    astTabNode.className = "tab ast-tab";
    astTabNode.appendChild(document.createTextNode('AST'));
    astTabNode.addEventListener('click', function(evt) {
      removeClass(resultsNode, 'show-errors');
      removeClass(resultsNode, 'show-json');
      resultsNode.className += ' show-ast';
      evt.preventDefault();
    });

    const versionSelector = document.createElement('select');
    flowVersions.forEach(
      function(version) {
        const option = document.createElement('option');
        option.value = version;
        option.text = version;
        option.selected = version == flowVersion;
        versionSelector.add(option, null);
      }
    );
    const versionTabNode = document.createElement('li');
    versionTabNode.className = "version";
    versionTabNode.appendChild(versionSelector);

    const toolbarNode = document.createElement('ul');
    toolbarNode.className = "toolbar";
    toolbarNode.appendChild(errorsTabNode);
    toolbarNode.appendChild(jsonTabNode);
    toolbarNode.appendChild(astTabNode);
    toolbarNode.appendChild(versionTabNode);

    const errorsNode = document.createElement('pre');
    errorsNode.className = "errors";

    const jsonNode = document.createElement('pre');
    jsonNode.className = "json";

    const astNode = document.createElement('pre');
    astNode.className = "ast";

    resultsNode.appendChild(toolbarNode);
    resultsNode.appendChild(errorsNode);
    resultsNode.appendChild(jsonNode);
    resultsNode.appendChild(astNode);

    resultsNode.className += " show-errors";

    const cursorPositionNode = document.querySelector('footer .cursor-position');
    const typeAtPosNode = document.querySelector('footer .type-at-pos');

    const editor = CodeMirror(domNode, {
      value: getHashedValue(location.hash) || defaultValue,
      autofocus: true,
      lineNumbers: true,
      mode: "jsx",
      flow: flowReady,
      lint: getAnnotations
    });

    editor.on('changes', () => {
      const value = editor.getValue();
      const encoded = LZString.compressToEncodedURIComponent(value);
      history.replaceState(undefined, undefined, `#0${encoded}`);
      localStorage.setItem('tryFlowLastContent', location.hash);
    });

    editor.on('cursorActivity', () => {
      const cursor = editor.getCursor();
      const value = editor.getValue();
      cursorPositionNode.innerHTML = `${cursor.line + 1}:${cursor.ch + 1}`;
      flowReady.then(() => {
        let typeAtPos;
        try {
          typeAtPos = self.flow.typeAtPos('-', value, cursor.line + 1, cursor.ch);
        } catch (err) {
          // ...
        } finally {
          typeAtPosNode.title = typeAtPos ? typeAtPos[1].c : '';
          typeAtPosNode.innerHTML = typeAtPos ? typeAtPos[1].c : '';
        }
      });
    });

    editor.on('flowErrors', errors => {
      if (errorsNode) {
        removeChildren(errorsNode);
        errorsNode.appendChild(printErrors(errors, editor));
      }

      if (jsonNode) {
        removeChildren(jsonNode);
        jsonNode.appendChild(
          document.createTextNode(JSON.stringify(errors, null, 2))
        );
      }

      if (astNode) {
        flowReady.then(() => {
          if (self.flow.parse) {
            let ast = self.flow.parse(editor.getValue(), {});
            removeChildren(astNode);
            astNode.appendChild(
              document.createTextNode(JSON.stringify(ast, null, 2))
            );
            astNode.dataset.disabled = "false";
          } else if (astNode.dataset.disabled !== "true") {
            astNode.dataset.disabled = "true";
            removeChildren(astNode);
            astNode.appendChild(
              document.createTextNode(
                "AST output is not supported in this version of Flow."
              )
            );
          }
        });
      }
    });

    versionTabNode.addEventListener('change', function(evt) {
      const version = evt.target.value;
      resultsNode.className += ' show-loading';
      const flowReady = initFlow(version);
      flowReady.then(function() {
        removeClass(resultsNode, 'show-loading');
      });
      editor.setOption('flow', flowReady);
    });
  });
}

exports.createEditor = createEditor;
