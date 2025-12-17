import unittest
import os
import sys
import tempfile
import json
import subprocess

# Add the python directory to the path
python_dir = os.path.dirname(os.path.abspath(__file__))
if python_dir not in sys.path:
    sys.path.insert(0, python_dir)

from inheritance_analyzer import InheritanceAnalyzer


class InheritanceAnalyzerSpec(unittest.TestCase):
    def setUp(self):
        """Set up test fixtures"""
        self.temp_dir = tempfile.mkdtemp()
        self.analyzer = InheritanceAnalyzer(self.temp_dir)

    def tearDown(self):
        """Clean up test fixtures"""
        import shutil
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir)

    def _create_test_file(self, filename: str, content: str) -> str:
        """Helper to create a test Python file"""
        file_path = os.path.join(self.temp_dir, filename)
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        return file_path

    def test_should_accept_multiple_file_paths(self):
        """Test that analyzer accepts multiple file paths"""
        # Create test files
        file1 = self._create_test_file('base.py', '''
class BaseClass:
    def method1(self):
        pass
''')
        file2 = self._create_test_file('derived.py', '''
class DerivedClass(BaseClass):
    def method1(self):
        pass
''')

        # Analyze both files
        result1 = self.analyzer.analyze_file(file1)
        result2 = self.analyzer.analyze_file(file2)

        # Both should return results
        self.assertIsInstance(result1, dict)
        self.assertIsInstance(result2, dict)

    def test_should_analyze_all_files_in_batch(self):
        """Test that all files in a batch are analyzed correctly"""
        # Create multiple test files
        files = []
        for i in range(5):
            content = f'''
class Class{i}:
    def method{i}(self):
        pass
'''
            file_path = self._create_test_file(f'file{i}.py', content)
            files.append(file_path)

        # Analyze all files
        results = {}
        for file_path in files:
            result = self.analyzer.analyze_file(file_path)
            results.update(result)

        # Should have results from all files
        self.assertGreater(len(results), 0)

    def test_should_merge_results_from_multiple_files(self):
        """Test that results from multiple files are combined properly"""
        # Create files with inheritance relationships
        file1 = self._create_test_file('base.py', '''
class Base:
    def base_method(self):
        pass
''')
        file2 = self._create_test_file('derived.py', '''
class Derived(Base):
    def base_method(self):
        pass
''')

        # Analyze both files
        self.analyzer.analyze_file(file1)
        self.analyzer.analyze_file(file2)

        # Get combined results
        combined_result = self.analyzer.inheritance_analyzer.to_json()

        # Should have entries for both files
        self.assertIn(file1, combined_result or {})
        self.assertIn(file2, combined_result or {})

    def test_should_handle_invalid_files_gracefully(self):
        """Test that invalid files don't crash entire batch"""
        # Create one valid and one invalid file
        valid_file = self._create_test_file('valid.py', '''
class Valid:
    def method(self):
        pass
''')
        invalid_file = os.path.join(self.temp_dir, 'nonexistent.py')

        # Should handle invalid file without crashing
        try:
            result1 = self.analyzer.analyze_file(valid_file)
            result2 = self.analyzer.analyze_file(invalid_file)
            # Invalid file should return empty dict
            self.assertIsInstance(result2, dict)
            # Valid file should still be processed
            self.assertIsInstance(result1, dict)
        except Exception as e:
            self.fail(f'Should handle invalid files gracefully: {e}')

    def test_should_handle_empty_file_list(self):
        """Test that empty file list is handled correctly"""
        # Create analyzer but don't analyze any files
        result = self.analyzer.inheritance_analyzer.to_json()
        self.assertIsInstance(result, dict)

    def test_should_handle_large_batches(self):
        """Test that large batches (50+ files) are handled efficiently"""
        # Create 50 test files
        files = []
        for i in range(50):
            content = f'''
class Class{i}:
    def method{i}(self):
        pass
'''
            file_path = self._create_test_file(f'file{i}.py', content)
            files.append(file_path)

        # Analyze all files
        for file_path in files:
            try:
                self.analyzer.analyze_file(file_path)
            except Exception as e:
                self.fail(f'Should handle large batches: {e}')

        # Get combined results
        result = self.analyzer.inheritance_analyzer.to_json()
        self.assertIsInstance(result, dict)

    def test_main_function_with_multiple_files(self):
        """Test that main() function accepts multiple file arguments"""
        # Create test files
        file1 = self._create_test_file('test1.py', 'class A: pass')
        file2 = self._create_test_file('test2.py', 'class B: pass')
        file3 = self._create_test_file('test3.py', 'class C: pass')

        # Test main function via subprocess
        analyzer_path = os.path.join(python_dir, 'inheritance_analyzer.py')
        result = subprocess.run(
            [sys.executable, analyzer_path, self.temp_dir, file1, file2, file3],
            capture_output=True,
            text=True,
            cwd=self.temp_dir
        )

        # Should succeed
        self.assertEqual(result.returncode, 0, f'Process should succeed: {result.stderr}')

        # Should return valid JSON
        try:
            output = json.loads(result.stdout)
            self.assertIsInstance(output, dict)
        except json.JSONDecodeError as e:
            self.fail(f'Should return valid JSON: {e}')


if __name__ == '__main__':
    unittest.main()

