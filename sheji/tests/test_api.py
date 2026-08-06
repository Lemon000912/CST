import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_root():
    """测试根路径"""
    response = client.get("/")
    assert response.status_code == 200
    assert "name" in response.json()


def test_health_check():
    """测试健康检查"""
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"


def test_login():
    """测试登录接口"""
    response = client.post(
        "/api/v1/auth/login",
        json={"username": "test", "password": "test123"}
    )
    assert response.status_code == 200
    assert "access_token" in response.json()


def test_search():
    """测试搜索接口"""
    response = client.post(
        "/api/v1/search/",
        json={
            "query": "材料科学",
            "source": "both",
            "max_results": 10
        }
    )
    assert response.status_code == 200
    assert "results" in response.json()


def test_recommend():
    """测试推荐接口"""
    response = client.post(
        "/api/v1/recommend/",
        json={
            "query": "推荐材料",
            "rec_type": "solution"
        }
    )
    assert response.status_code == 200
    assert "recommendations" in response.json()
