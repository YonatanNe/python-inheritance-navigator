import os
import sys
from typing import List, Dict, Optional, Set
from dataclasses import dataclass, asdict
from method_extractor import MethodInfo


@dataclass
class MethodRelationship:
    method: MethodInfo
    base_methods: List[MethodInfo]
    override_methods: List[MethodInfo]


class MethodInheritanceAnalyzer:
    def __init__(self):
        self.class_methods: Dict[str, List[MethodInfo]] = {}
        self.class_mro: Dict[str, List[str]] = {}
        self.class_to_file: Dict[str, str] = {}
        self.class_base_classes: Dict[str, List[str]] = {}
        self.class_subclasses: Dict[str, List[str]] = {}
        self.class_line_numbers: Dict[str, int] = {}  # Store class definition line numbers
    
    def register_class(
        self, class_full_name: str, methods: List[MethodInfo], mro: List[str], file_path: str, direct_base_classes: List[str] = None, class_line: int = None
    ):
        self.class_methods[class_full_name] = methods
        self.class_mro[class_full_name] = mro
        self.class_to_file[class_full_name] = file_path
        if class_line is not None:
            self.class_line_numbers[class_full_name] = class_line
        
        # Use provided direct base classes, or extract from MRO as fallback
        if direct_base_classes:
            base_classes = direct_base_classes
        else:
            # Fallback: extract from MRO (first non-object classes after the class itself)
            base_classes = []
            if len(mro) > 1:
                for parent in mro[1:]:
                    if parent != 'builtins.object':
                        base_classes.append(parent)
        
        self.class_base_classes[class_full_name] = base_classes
        
        # Track subclasses (reverse relationship)
        # Normalize base class names to match registered class names
        for base_class in base_classes:
            # Try to find the actual registered class name that matches this base class
            normalized_base_class = self._normalize_base_class_name(base_class, file_path)
            
            if normalized_base_class not in self.class_subclasses:
                self.class_subclasses[normalized_base_class] = []
            if class_full_name not in self.class_subclasses[normalized_base_class]:
                self.class_subclasses[normalized_base_class].append(class_full_name)
    
    def _normalize_base_class_name(self, base_class_name: str, current_file_path: str) -> str:
        """Normalize a base class name to match registered class names.
        
        This handles cases where the MRO calculator resolves class names differently
        than how they're registered (e.g., '__main__.BaseChannel' vs 'channels.BaseChannel').
        """
        try:
            # First, try exact match
            if base_class_name in self.class_methods:
                return base_class_name
            
            if not base_class_name or '.' not in base_class_name:
                return base_class_name
            
            short_name = base_class_name.split('.')[-1]
            
            # Try to find by short name (last part after dot) in the same file first
            # This is most reliable when classes are in the same file
            for registered_name, registered_file in self.class_to_file.items():
                if registered_file == current_file_path and registered_name.split('.')[-1] == short_name:
                    return registered_name
            
            # Try to find by short name in any file (fallback)
            # If multiple matches, prefer the one that's most likely (e.g., same directory)
            matches = []
            current_dir = os.path.dirname(current_file_path) if current_file_path else ''
            
            for registered_name, registered_file in self.class_to_file.items():
                if registered_name.split('.')[-1] == short_name:
                    registered_dir = os.path.dirname(registered_file) if registered_file else ''
                    # Prefer matches in the same directory
                    if registered_dir == current_dir:
                        return registered_name
                    matches.append(registered_name)
            
            # Return first match if found, otherwise return original
            if matches:
                return matches[0]
            
            # If no match found, return original (will be tracked but might not link properly)
            return base_class_name
        except Exception as e:
            # If normalization fails, return original and log error
            import sys
            print(f'Warning: Error normalizing base class name {base_class_name}: {e}', file=sys.stderr)
            return base_class_name
    
    def find_base_methods(self, class_name: str, method_name: str) -> List[MethodInfo]:
        base_methods = []
        
        try:
            if class_name not in self.class_mro:
                return base_methods
            
            mro = self.class_mro[class_name]
            current_file = self.class_to_file.get(class_name, '')
            
            for parent_class in mro[1:]:
                try:
                    # Normalize parent class name to match registered class names
                    normalized_parent = self._normalize_base_class_name(parent_class, current_file)
                    
                    if normalized_parent in self.class_methods:
                        for method in self.class_methods[normalized_parent]:
                            if method.name == method_name:
                                base_methods.append(method)
                                break
                except Exception as e:
                    # Log normalization errors but continue
                    import sys
                    print(f'Warning: Failed to normalize base class {parent_class} for {class_name}: {e}', file=sys.stderr)
                    import traceback
                    traceback.print_exc(file=sys.stderr)
                    continue
        except Exception as e:
            import sys
            print(f'Error in find_base_methods for {class_name}.{method_name}: {e}', file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
        
        return base_methods
    
    def find_override_methods(self, class_name: str, method_name: str) -> List[MethodInfo]:
        override_methods = []
        
        try:
            # Get the file path for the base class to help with normalization
            base_class_file = self.class_to_file.get(class_name, '')
            class_short_name = class_name.split('.')[-1]
            
            for candidate_class, methods in self.class_methods.items():
                if candidate_class == class_name:
                    continue
                
                try:
                    if candidate_class not in self.class_mro:
                        continue
                    
                    mro = self.class_mro[candidate_class]
                    candidate_file = self.class_to_file.get(candidate_class, '')
                    
                    # Normalize each MRO entry and check if it matches the base class
                    mro_matches = False
                    for mro_class in mro:
                        try:
                            # Try exact match first
                            if mro_class == class_name:
                                mro_matches = True
                                break
                            
                            # Try normalization - this is the key fix
                            normalized_mro_class = self._normalize_base_class_name(mro_class, candidate_file)
                            if normalized_mro_class == class_name:
                                mro_matches = True
                                break
                            
                            # Also check if the normalized MRO class matches by short name
                            normalized_short = normalized_mro_class.split('.')[-1] if '.' in normalized_mro_class else normalized_mro_class
                            if normalized_short == class_short_name:
                                # Verify this is actually the same class by checking if it's registered
                                if normalized_mro_class in self.class_methods:
                                    mro_matches = True
                                    break
                            
                            # Try short name match as fallback (less reliable but needed for some cases)
                            mro_short = mro_class.split('.')[-1] if '.' in mro_class else mro_class
                            if mro_short == class_short_name:
                                # Additional check: verify the normalized version matches
                                if normalized_mro_class in self.class_methods or normalized_mro_class == class_name:
                                    mro_matches = True
                                    break
                        except Exception as e:
                            # Log normalization errors but continue checking other MRO entries
                            import sys
                            print(f'Warning: Failed to normalize MRO class {mro_class} for candidate {candidate_class}: {e}', file=sys.stderr)
                            continue
                    
                    if mro_matches:
                        for method in methods:
                            if method.name == method_name:
                                override_methods.append(method)
                                break
                except Exception as e:
                    # Log errors for individual candidate classes but continue
                    import sys
                    print(f'Warning: Error checking override for candidate {candidate_class}: {e}', file=sys.stderr)
                    continue
        except Exception as e:
            import sys
            print(f'Error in find_override_methods for {class_name}.{method_name}: {e}', file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
        
        return override_methods
    
    def analyze_method_relationships(self) -> Dict[str, List[MethodRelationship]]:
        relationships_by_file: Dict[str, List[MethodRelationship]] = {}
        
        total_classes = len(self.class_methods)
        processed_classes = 0
        
        for class_name, methods in self.class_methods.items():
            file_path = self.class_to_file.get(class_name, '')
            
            if file_path not in relationships_by_file:
                relationships_by_file[file_path] = []
            
            for method in methods:
                try:
                    base_methods = self.find_base_methods(class_name, method.name)
                    override_methods = self.find_override_methods(class_name, method.name)
                    
                    if base_methods or override_methods:
                        relationship = MethodRelationship(
                            method=method,
                            base_methods=base_methods,
                            override_methods=override_methods
                        )
                        relationships_by_file[file_path].append(relationship)
                except Exception as e:
                    # Log errors to stderr so they appear in logs
                    print(f'Error analyzing method {class_name}.{method.name}: {e}', file=sys.stderr)
                    import traceback
                    traceback.print_exc(file=sys.stderr)
                    # Continue processing other methods even if one fails
            
            # Log progress every 50 classes or at milestones
            processed_classes += 1
            if processed_classes % 50 == 0 or processed_classes == total_classes or (
                total_classes > 10 and (
                    processed_classes == int(total_classes * 0.25) or
                    processed_classes == int(total_classes * 0.5) or
                    processed_classes == int(total_classes * 0.75)
                )
            ):
                percent = int((processed_classes / total_classes) * 100) if total_classes > 0 else 0
                print(f'[PROGRESS] Computing relationships: {processed_classes}/{total_classes} classes ({percent}%)', file=sys.stderr)
        
        return relationships_by_file
    
    def to_json(self) -> Dict:
        relationships = self.analyze_method_relationships()
        
        result = {}
        for file_path, rels in relationships.items():
            result[file_path] = []
            for rel in rels:
                result[file_path].append({
                    'method': {
                        'name': rel.method.name,
                        'class_name': rel.method.class_name,
                        'line': rel.method.line,
                        'column': rel.method.column,
                        'end_line': rel.method.end_line,
                        'end_column': rel.method.end_column,
                        'is_async': rel.method.is_async,
                        'is_abstract': rel.method.is_abstract,
                        'decorators': rel.method.decorators
                    },
                    'base_methods': [
                        {
                            'name': m.name,
                            'class_name': m.class_name,
                            'file_path': m.file_path,
                            'line': m.line,
                            'column': m.column,
                            'end_line': m.end_line,
                            'end_column': m.end_column
                        }
                        for m in rel.base_methods
                    ],
                    'override_methods': [
                        {
                            'name': m.name,
                            'class_name': m.class_name,
                            'file_path': m.file_path,
                            'line': m.line,
                            'column': m.column,
                            'end_line': m.end_line,
                            'end_column': m.end_column
                        }
                        for m in rel.override_methods
                    ]
                })
        
        # Add class-level inheritance information to a separate structure
        class_inheritance = {}
        for class_name, base_classes in self.class_base_classes.items():
            file_path = self.class_to_file.get(class_name)
            if file_path:
                if file_path not in class_inheritance:
                    class_inheritance[file_path] = {}
                # Extract just the class name without module prefix
                short_class_name = class_name.split('.')[-1]
                class_inheritance[file_path][short_class_name] = {
                    'full_name': class_name,
                    'base_classes': base_classes,
                    'sub_classes': self.class_subclasses.get(class_name, []),
                    'line': self.class_line_numbers.get(class_name, 0)  # Include class definition line
                }
        
        # Merge class inheritance into result
        # IMPORTANT: Include ALL files that have registered classes, even if they have no method relationships
        # This ensures base classes with only abstract methods (no relationships yet) are still included
        for class_name, file_path in self.class_to_file.items():
            if file_path and file_path not in result:
                # File has classes but no method relationships - create empty entry
                result[file_path] = {
                    'methods': [],
                    'classes': {}
                }
        
        # Now merge class inheritance data
        for file_path in class_inheritance:
            if file_path not in result:
                result[file_path] = {
                    'methods': [],
                    'classes': {}
                }
            # Add class inheritance as metadata
            if isinstance(result[file_path], list):
                # Convert to dict format to include class info
                result[file_path] = {
                    'methods': result[file_path],
                    'classes': class_inheritance[file_path]
                }
            elif isinstance(result[file_path], dict):
                # Already in dict format, merge classes
                if 'classes' not in result[file_path]:
                    result[file_path]['classes'] = {}
                result[file_path]['classes'].update(class_inheritance[file_path])
        
        return result

