const chokidar = require('chokidar');
const fs = require('fs/promises');
const { wasSelfWrite } = require('./echo-suppression.cjs');
const { diffChars } = require('diff');

// Chokidar v4+ removed glob support — we watch the rootDir recursively and
// filter `.md` files in the `ignored` predicate.
function startWatcher({ rootDir, onExternalChange }) {
  const watcher = chokidar.watch(rootDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    ignored: (filePath, stats) => {
      // Skip dotfiles/dot-dirs anywhere in the path.
      if (/(^|[\/\\])\../.test(filePath)) return true;
      // Always allow directories so chokidar can descend.
      if (stats && stats.isDirectory()) return false;
      // For files (or unknown stats), only allow .md.
      if (stats && stats.isFile()) return !filePath.endsWith('.md');
      return false;
    },
  });

  const handleChange = (kind) => async (filePath) => {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (wasSelfWrite(filePath, content)) return;
      onExternalChange({ filePath, content, kind });
    } catch (err) {
      console.error('Watcher read failed:', filePath, err.message);
    }
  };

  watcher.on('change', handleChange('change'));
  watcher.on('add', handleChange('add'));

  watcher.on('unlink', (filePath) => {
    if (!filePath.endsWith('.md')) return;
    onExternalChange({ filePath, content: null, kind: 'unlink' });
  });

  return {
    stop: () => watcher.close(),
  };
}

function computeReconciliationOps(currentText, newText) {
  return diffChars(currentText, newText);
}

module.exports = { startWatcher, computeReconciliationOps };
