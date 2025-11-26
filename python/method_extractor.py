import ast
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple, Union


@dataclass
class MethodInfo:
    name: str
    line: int
    column: int
    end_line: int
    end_column: int
    is_async: bool
    is_abstract: bool
    is_static: bool
    is_classmethod: bool
    is_property: bool
    decorators: List[str]
    file_path: str
    class_name: str


class MethodExtractor:
    def extract_methods_from_class(
        self, class_node: ast.ClassDef, file_path: str, class_name: str, start_line_offset: int = 0
    ) -> List[MethodInfo]:
        methods = []
        
        for node in ast.walk(class_node):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if self._is_method(node, class_node):
                    method_info = self._extract_method_info(
                        node, file_path, class_name, start_line_offset
                    )
                    if method_info:
                        methods.append(method_info)
        
        return methods
    
    def _is_method(self, func_node: Union[ast.FunctionDef, ast.AsyncFunctionDef], class_node: ast.ClassDef) -> bool:
        for node in ast.walk(class_node):
            if node == func_node:
                return True
        return False
    
    def _extract_method_info(
        self, func_node: Union[ast.FunctionDef, ast.AsyncFunctionDef], file_path: str, 
        class_name: str, start_line_offset: int
    ) -> Optional[MethodInfo]:
        is_async = isinstance(func_node, ast.AsyncFunctionDef)
        is_abstract = False
        is_static = False
        is_classmethod = False
        is_property = False
        decorators = []
        
        for decorator in func_node.decorator_list:
            decorator_name = self._get_decorator_name(decorator)
            if decorator_name:
                decorators.append(decorator_name)
                if decorator_name in ('abstractmethod', 'abc.abstractmethod'):
                    is_abstract = True
                elif decorator_name == 'staticmethod':
                    is_static = True
                elif decorator_name == 'classmethod':
                    is_classmethod = True
                elif decorator_name in ('property', 'cached_property'):
                    is_property = True
        
        line = func_node.lineno + start_line_offset
        column = func_node.col_offset
        end_line = getattr(func_node, 'end_lineno', line) + start_line_offset if hasattr(func_node, 'end_lineno') else line
        end_column = getattr(func_node, 'end_col_offset', column) if hasattr(func_node, 'end_col_offset') else column
        
        return MethodInfo(
            name=func_node.name,
            line=line,
            column=column,
            end_line=end_line,
            end_column=end_column,
            is_async=is_async,
            is_abstract=is_abstract,
            is_static=is_static,
            is_classmethod=is_classmethod,
            is_property=is_property,
            decorators=decorators,
            file_path=file_path,
            class_name=class_name
        )
    
    def _get_decorator_name(self, decorator: ast.expr) -> Optional[str]:
        if isinstance(decorator, ast.Name):
            return decorator.id
        elif isinstance(decorator, ast.Attribute):
            if isinstance(decorator.value, ast.Name):
                return f'{decorator.value.id}.{decorator.attr}'
        elif isinstance(decorator, ast.Call):
            if isinstance(decorator.func, ast.Name):
                return decorator.func.id
            elif isinstance(decorator.func, ast.Attribute):
                if isinstance(decorator.func.value, ast.Name):
                    return f'{decorator.func.value.id}.{decorator.func.attr}'
        return None

