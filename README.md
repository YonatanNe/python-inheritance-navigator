# Python Inheritance Navigator

A VS Code extension that helps developers navigate Python method inheritance by providing "Go to Base Method" and "Go to Overrides" commands via CodeLens.

## Features

- **Go to Base Method**: Navigate to the base method definition when a method overrides a parent class method
- **Go to Overrides**: See all subclasses that override a method and navigate to them
- **CodeLens Integration**: Visual links above method definitions showing inheritance relationships
- **Background Indexing**: Eager background indexing of workspace Python files
- **Real-time Updates**: Automatically updates when files change

## Requirements

- Python 3.6+
- VS Code 1.74.0 or higher
- `python-mro-language-server` package (installed automatically)

## Installation

1. Install the extension from the VS Code marketplace (when published)
2. Or clone this repository and build:
   ```bash
   npm install
   npm run compile
   ```

## Usage

1. Open a Python workspace in VS Code
2. The extension will automatically index all Python files in the background
3. CodeLens links will appear above methods that have base/override relationships:
   - **"Go to Base: ClassName.method"** - appears above methods that override a base class method
   - **"Go to Overrides (N)"** - appears above methods that are overridden by N subclasses
4. Click on the CodeLens links to navigate to the base method or select from override locations

## Configuration

The extension provides the following settings:

- `pythonInheritance.enableCodeLens`: Enable/disable CodeLens links (default: `true`)
- `pythonInheritance.showBaseMethods`: Show "Go to Base" links (default: `true`)
- `pythonInheritance.showOverrides`: Show "Go to Overrides" links (default: `true`)
- `pythonInheritance.indexingScope`: Scope of files to index - `workspace` or `openFiles` (default: `workspace`)

## Supported Patterns

- Abstract base classes with `@abc.abstractmethod` decorators
- Method overriding in inheritance hierarchies
- Multiple inheritance (MRO-based)
- Async methods (`async def`)
- Static methods, class methods, and properties

## Troubleshooting

### Logging

The extension logs all operations to a file for debugging:
- **Log location**: `.vscode/python-inheritance-navigator.log` in your workspace root
- The log file is automatically deleted and recreated on each extension activation
- Logs include: initialization, Python process spawning, indexing progress, and errors

If you encounter issues:
1. Check the log file for detailed error messages
2. Look for Python path issues (the log shows which Python executable is being used)
3. Verify that `python-mro-language-server` is installed in your Python environment

### Common Issues

**"Failed to spawn Python process: spawn python ENOENT"**
- The extension can't find the Python executable
- Set the Python path in VS Code settings: `python.pythonPath` or `python.defaultInterpreterPath`
- Or ensure `python3` is in your system PATH

**"Python analyzer exited with code X"**
- Check the log file for the full error message from the Python analyzer
- Ensure `python-mro-language-server` is installed: `pip install python-mro-language-server jedi`

## Limitations

- Dynamic inheritance (runtime class modifications) is not detected
- Third-party libraries without source code may have limited analysis
- Method signature matching is name-based, not full signature validation
- Large codebases may take time to index initially

## Development

### Building

```bash
npm install
npm run compile
```

### Manual Testing (Keep VS Code Open)

To test the extension manually with Python files:

**Option 1: Using VS Code Debugger (Recommended)**
1. Open this project in VS Code
2. Press `F5` or go to Run > Start Debugging
3. A new VS Code window will open with the extension loaded
4. Open Python files in that window to test the extension
5. The window stays open until you close it

**Option 2: Using npm script**
```bash
npm run dev
```

**Option 3: Using shell script**
```bash
./scripts/launch-dev.sh
```

### Automated Testing

```bash
npm test
```

## License

MIT License - see LICENSE file for details

