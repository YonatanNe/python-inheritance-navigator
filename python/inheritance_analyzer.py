import ast
import json
import os
import sys
from typing import Dict
from typing import List

from mrols.calculator import MROCalculator
from mrols.parsed_custom_class import ParsedCustomClass


# Add the python directory to the path so imports work when running as a script
python_dir = os.path.dirname(os.path.abspath(__file__))
if python_dir not in sys.path:
    sys.path.insert(0, python_dir)

from method_extractor import MethodExtractor
from method_extractor import MethodInfo
from method_inheritance import MethodInheritanceAnalyzer


class InheritanceAnalyzer:
    def __init__(self, root_dir: str):
        self.root_dir = root_dir
        self.calculator = MROCalculator(root_dir)
        self.method_extractor = MethodExtractor()
        self.inheritance_analyzer = MethodInheritanceAnalyzer()
    
    def analyze_file(self, file_path: str) -> Dict:
        if not os.path.exists(file_path):
            return {}
        
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        self.calculator.replace_content_in_cache(file_path, content)
        self.calculator.update_one(file_path)
        
        if file_path not in self.calculator.parsed_names_by_path:
            return {}
        
        parsed_classes = self.calculator.parsed_names_by_path[file_path]
        
        for parsed_class in parsed_classes:
            if isinstance(parsed_class, ParsedCustomClass):
                self._analyze_class(parsed_class, file_path)
        
        return self.inheritance_analyzer.to_json()
    
    def _analyze_class(self, parsed_class: ParsedCustomClass, file_path: str):
        class_full_name = parsed_class.full_name
        mro = [cls.full_name for cls in parsed_class.mro_parsed_list]
        
        # Extract direct base classes from ParsedCustomClass's _base_parent_names
        direct_base_classes = []
        try:
            # Use the base parent names that ParsedCustomClass already resolved
            if hasattr(parsed_class, '_base_parent_names'):
                for base_name in parsed_class._base_parent_names:
                    if hasattr(base_name, 'full_name') and base_name.full_name:
                        full_name = base_name.full_name
                        if full_name != 'builtins.object':
                            direct_base_classes.append(full_name)
            
            class_def_ast = parsed_class._get_class_def_ast_from_lines()
            # Get class definition line number (AST line numbers are 1-based)
            class_line = parsed_class.start_pos[0]  # start_pos is (line, column) where line is 1-based
            
            methods = self.method_extractor.extract_methods_from_class(
                class_def_ast, file_path, parsed_class.jedi_name.name, 
                start_line_offset=parsed_class.start_pos[0] - 1
            )
            
            self.inheritance_analyzer.register_class(class_full_name, methods, mro, file_path, direct_base_classes, class_line)
        except Exception as e:
            print(f'Error analyzing class {class_full_name}: {e}', file=sys.stderr)
    
    def analyze_workspace(self, workspace_root: str) -> Dict:
        python_files = []
        
        for root, dirs, files in os.walk(workspace_root):
            dirs[:] = [d for d in dirs if d not in ('.git', '__pycache__', '.venv', 'venv', 'node_modules')]
            
            for file in files:
                if file.endswith('.py'):
                    file_path = os.path.join(root, file)
                    python_files.append(file_path)
        
        total_files = len(python_files)
        files_with_inheritance = 0
        
        for file_path in python_files:
            try:
                result = self.analyze_file(file_path)
                if result and len(result) > 0:
                    files_with_inheritance += 1
            except Exception as e:
                print(f'Error analyzing {file_path}: {e}', file=sys.stderr)
        
        final_result = self.inheritance_analyzer.to_json()
        files_indexed = len(final_result)
        
        # Log statistics to stderr (won't break JSON output)
        print(f'[STATS] Scanned {total_files} Python files, found inheritance in {files_indexed} files', file=sys.stderr)
        
        return final_result


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: inheritance_analyzer.py <workspace_root> [file_path]'}), file=sys.stderr)
        sys.exit(1)
    
    workspace_root = sys.argv[1]
    analyzer = InheritanceAnalyzer(workspace_root)
    
    if len(sys.argv) > 2:
        file_path = sys.argv[2]
        result = analyzer.analyze_file(file_path)
    else:
        result = analyzer.analyze_workspace(workspace_root)
    
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()

