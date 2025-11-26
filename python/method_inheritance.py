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
        for base_class in base_classes:
            if base_class not in self.class_subclasses:
                self.class_subclasses[base_class] = []
            if class_full_name not in self.class_subclasses[base_class]:
                self.class_subclasses[base_class].append(class_full_name)
    
    def find_base_methods(self, class_name: str, method_name: str) -> List[MethodInfo]:
        base_methods = []
        
        if class_name not in self.class_mro:
            return base_methods
        
        mro = self.class_mro[class_name]
        
        for parent_class in mro[1:]:
            if parent_class in self.class_methods:
                for method in self.class_methods[parent_class]:
                    if method.name == method_name:
                        base_methods.append(method)
                        break
        
        return base_methods
    
    def find_override_methods(self, class_name: str, method_name: str) -> List[MethodInfo]:
        override_methods = []
        
        for candidate_class, methods in self.class_methods.items():
            if candidate_class == class_name:
                continue
            
            if candidate_class in self.class_mro:
                mro = self.class_mro[candidate_class]
                if class_name in mro:
                    for method in methods:
                        if method.name == method_name:
                            override_methods.append(method)
                            break
        
        return override_methods
    
    def analyze_method_relationships(self) -> Dict[str, List[MethodRelationship]]:
        relationships_by_file: Dict[str, List[MethodRelationship]] = {}
        
        for class_name, methods in self.class_methods.items():
            file_path = self.class_to_file.get(class_name, '')
            
            if file_path not in relationships_by_file:
                relationships_by_file[file_path] = []
            
            for method in methods:
                base_methods = self.find_base_methods(class_name, method.name)
                override_methods = self.find_override_methods(class_name, method.name)
                
                if base_methods or override_methods:
                    relationship = MethodRelationship(
                        method=method,
                        base_methods=base_methods,
                        override_methods=override_methods
                    )
                    relationships_by_file[file_path].append(relationship)
        
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
        for file_path in class_inheritance:
            if file_path not in result:
                result[file_path] = []
            # Add class inheritance as metadata
            if isinstance(result[file_path], list):
                # Convert to dict format to include class info
                result[file_path] = {
                    'methods': result[file_path],
                    'classes': class_inheritance[file_path]
                }
        
        return result

